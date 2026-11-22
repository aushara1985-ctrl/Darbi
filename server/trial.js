'use strict';
// 7-day Pro trial for NEW signups + Resend emails (welcome, 2 days before end, last day).
// - Existing users have trial_ends_at = NULL, so nothing changes for them.
// - During the trial the API reports paid:true (access_status stays 'free' in the DB).
//   When the trial ends the user is simply free again; no data is ever deleted.
// - Emails: skipped silently unless RESEND_API_KEY is set AND EMAIL_DOMAIN_VERIFIED=1.
//   Each email has a per-user flag in users.trial_emails (JSONB), claimed before sending.

const TRIAL_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;
const FROM = 'دربي <hala@darbi.live>';
const APP_URL = (process.env.APP_URL || 'https://www.darbi.live').replace(/\/$/, '');

function trialInfo(row, now = Date.now()) {
  const end = row && row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : null;
  if (!end) return { active: false, days_left: 0, expired: false };
  const left = end - now;
  if (left > 0) return { active: true, days_left: Math.max(1, Math.ceil(left / DAY)), expired: false };
  return { active: false, days_left: 0, expired: true };
}

// The user object sent to the client. An active trial on a free account reads as paid.
function publicUser(row, now = Date.now()) {
  const trial = trialInfo(row, now);
  const paid = row.access_status === 'paid';
  return {
    id: row.id,
    email: row.email,
    access_status: row.access_status,
    referral_code: row.referral_code,
    created_at: row.created_at,
    paid: paid || (row.access_status === 'free' && trial.active),
    trial,
  };
}

function emailEnabled(env = process.env) {
  return Boolean(env.RESEND_API_KEY && env.RESEND_API_KEY.trim()) && String(env.EMAIL_DOMAIN_VERIFIED || '').trim() === '1';
}

async function sendEmail(to, subject, html, env = process.env, fetchFn = globalThis.fetch) {
  if (!emailEnabled(env) || !to) return false;
  try {
    const r = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
    });
    return !!r.ok;
  } catch (e) { return false; }
}

function wrap(title, body) {
  return '<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:520px;margin:auto;padding:24px;color:#222;line-height:1.8">'
    + '<h2 style="margin:0 0 12px">' + title + '</h2>' + body
    + '<p><a href="' + APP_URL + '" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">افتح دربي</a></p>'
    + '<p style="color:#888;font-size:12px">فريق دربي</p></div>';
}

const TEMPLATES = {
  welcome: () => ({
    subject: 'أهلاً بك في دربي — تجربتك المجانية بدأت',
    html: wrap('أهلاً بك في دربي', '<p>بدأت تجربتك المجانية لمدة ' + TRIAL_DAYS + ' أيام: تجهيز تقديمات بلا حد، تدريب المقابلات، وكل اختبارات الجاهزية.</p><p>ابدأ بتشخيص سيرتك الذاتية، وهي أسرع خطوة.</p>'),
  }),
  d2: () => ({
    subject: 'باقي يومان على نهاية تجربتك في دربي',
    html: wrap('باقي يومان من تجربتك', '<p>تجربتك المجانية تنتهي بعد يومين. بياناتك وتقدّمك محفوظة، وترجع بعدها للخطة المجانية.</p><p>الدفع الإلكتروني يتفعّل قريباً — نبلغك أول ما يفتح.</p>'),
  }),
  d0: () => ({
    subject: 'اليوم آخر يوم في تجربتك المجانية',
    html: wrap('آخر يوم في تجربتك', '<p>اليوم آخر يوم في التجربة. بياناتك محفوظة ولن يُحذف منها شيء.</p><p>الدفع الإلكتروني يتفعّل قريباً — نبلغك أول ما يفتح.</p>'),
  }),
};

// Claim the flag first (atomic), send, and release the claim if the send failed.
async function sendOnce(db, userId, email, key, deps = {}) {
  if (!emailEnabled(deps.env || process.env) || !email) return false;
  const claim = await db.query(
    `UPDATE users SET trial_emails = COALESCE(trial_emails, '{}'::jsonb) || jsonb_build_object($2::text, NOW()::text)
     WHERE id = $1 AND NOT (COALESCE(trial_emails, '{}'::jsonb) ? $2::text) RETURNING id`,
    [userId, key]
  );
  if (!claim.rows[0]) return false;
  const t = TEMPLATES[key]();
  const ok = await (deps.send || sendEmail)(email, t.subject, t.html);
  if (!ok) await db.query(`UPDATE users SET trial_emails = COALESCE(trial_emails, '{}'::jsonb) - $2::text WHERE id = $1`, [userId, key]).catch(() => {});
  return ok;
}

async function startTrial(db, userId) {
  await db.query(`UPDATE users SET trial_ends_at = NOW() + ($2 || ' days')::interval WHERE id = $1 AND trial_ends_at IS NULL`, [userId, String(TRIAL_DAYS)]);
}

async function runReminders(db, deps = {}) {
  if (!emailEnabled(deps.env || process.env)) return 0;
  const { rows } = await db.query(
    `SELECT id, email, trial_ends_at, trial_emails FROM users
     WHERE access_status = 'free' AND trial_ends_at > NOW() AND trial_ends_at < NOW() + INTERVAL '2 days' LIMIT 500`
  );
  let n = 0;
  for (const u of rows) {
    const left = new Date(u.trial_ends_at).getTime() - Date.now();
    const sent = u.trial_emails || {};
    const key = left <= DAY ? 'd0' : 'd2';
    if (sent[key]) continue;
    if (await sendOnce(db, u.id, u.email, key, deps).catch(() => false)) n++;
  }
  return n;
}

function startScheduler(db) {
  const tick = () => runReminders(db).catch((e) => console.error('[trial] reminder sweep failed:', e.message));
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, 60 * 60 * 1000).unref();
}

module.exports = { TRIAL_DAYS, trialInfo, publicUser, emailEnabled, sendEmail, sendOnce, startTrial, runReminders, startScheduler };
