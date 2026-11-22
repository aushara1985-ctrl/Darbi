'use strict';
// Word-of-mouth referral program.
// Link: <site>/?ref=u-<code>. A friend counts only after (1) a real signup that came through the link and
// (2) their first completed diagnosis (Darbi's auth does not verify email, so a real first action is the check).
// Rewards extend users.trial_ends_at (the existing Pro-until field). Access is never reduced.
//   2 friends = 7 days, every extra friend = +3 days, cap 30 days per user (never shown to users).
// Idempotent: one reward per referred user (atomic claim of the pending row, under a per-referrer row lock).

const crypto = require('crypto');

const NEED = 2;        // friends needed for the first reward
const BASE_DAYS = 7;   // reward for reaching NEED
const EXTRA_DAYS = 3;  // per friend after NEED
const CAP_DAYS = 30;   // max days earned per user
const APP_URL = (process.env.APP_URL || 'https://www.darbi.live').replace(/\/$/, '');

// Total days a user should have earned once n friends have qualified.
function totalDaysFor(n) {
  if (!(n >= NEED)) return 0;
  return Math.min(CAP_DAYS, BASE_DAYS + EXTRA_DAYS * (n - NEED));
}

// "u-ABC123" / "ABC123" / " u-abc123 " -> "ABC123"; anything unusable -> null.
function parseRef(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (/^u-/i.test(s)) s = s.slice(2);
  s = s.toUpperCase();
  return /^[A-Z0-9]{4,16}$/.test(s) ? s : null;
}

function hashSignal(value, salt) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(salt || '') + '|' + String(value)).digest('hex').slice(0, 32);
}

// gmail-style aliases (a.b+x@gmail.com == ab@gmail.com) must not count as a different person.
function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at); let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  local = local.split('+')[0];
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local + '@' + domain;
}

function maskEmail(email) {
  const local = String(email || '').split('@')[0] || '';
  return (local.slice(0, 2) || '•') + '•••';
}

function linkFor(code) { return APP_URL + '/?ref=u-' + code; }

function shareText(link) {
  return 'جرّبت دربي لتجهيز سيرتي والتقديم على الوظائف، وفيه أسبوع تجربة Pro مجاني لأي حساب جديد. سجّل من رابطي: ' + link;
}

function progressLine(qualified) {
  const q = Math.max(0, qualified | 0);
  if (q === 0) return 'دعيت 0 من 2 — باقي اثنين وتاخذ أسبوع Pro';
  if (q === 1) return 'دعيت 1 من 2 — باقي واحد وتاخذ أسبوع Pro';
  return 'دعيت ' + q + ' — كل صديق جديد يضيف لك 3 أيام Pro';
}

// Record that a NEW account came through someone's link. Never grants anything.
// Returns { recorded, reason }.
async function recordPending(db, { referredId, referredEmail, rawCode, ip, device, salt }) {
  const code = parseRef(rawCode);
  if (!code) return { recorded: false, reason: 'no_code' };
  const ref = await db.query('SELECT id, email, device_hash FROM users WHERE referral_code = $1', [code]);
  const referrer = ref.rows[0];
  if (!referrer) return { recorded: false, reason: 'unknown_code' };
  // One referrer per referred user, ever.
  const already = await db.query('SELECT 1 FROM referrals WHERE referred_id = $1 LIMIT 1', [referredId]);
  if (already.rows[0]) return { recorded: false, reason: 'exists' };
  const deviceHash = hashSignal(device, salt);
  const ipHash = hashSignal(ip, salt);
  let status = 'pending'; let reason = null;
  if (referrer.id === referredId) { status = 'rejected'; reason = 'self'; }
  else if (normalizeEmail(referrer.email) === normalizeEmail(referredEmail)) { status = 'rejected'; reason = 'same_email'; }
  else if (deviceHash && referrer.device_hash && referrer.device_hash === deviceHash) { status = 'rejected'; reason = 'same_device'; }
  else if (deviceHash) {
    // The same device already brought another friend for this referrer.
    const dup = await db.query(
      `SELECT 1 FROM referrals WHERE referrer_id = $1 AND referred_device_hash = $2 AND status <> 'rejected' LIMIT 1`,
      [referrer.id, deviceHash]
    );
    if (dup.rows[0]) { status = 'rejected'; reason = 'same_device'; }
  }
  const ins = await db.query(
    `INSERT INTO referrals (referrer_id, referred_id, status, reject_reason, referred_ip_hash, referred_device_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (referrer_id, referred_id) DO NOTHING RETURNING id`,
    [referrer.id, referredId, status, reason, ipHash, deviceHash]
  );
  if (!ins.rows[0]) return { recorded: false, reason: 'exists' };
  return { recorded: status === 'pending', reason: reason || null, status };
}

// Called when the referred user completes their first diagnosis. Safe to call any number of times.
// Returns { granted, days, qualified } — granted:false on every call after the first.
async function qualify(db, referredId) {
  const client = db.connect ? await db.connect() : db;
  const release = () => { if (client.release) client.release(); };
  try {
    await client.query('BEGIN');
    const pend = await client.query(
      `SELECT id, referrer_id FROM referrals WHERE referred_id = $1 AND status = 'pending' ORDER BY id LIMIT 1`, [referredId]
    );
    if (!pend.rows[0]) { await client.query('ROLLBACK'); return { granted: false, days: 0 }; }
    const { id, referrer_id: referrerId } = pend.rows[0];
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [referrerId]);
    const claim = await client.query(
      `UPDATE referrals SET status = 'qualified', qualified_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING id`, [id]
    );
    if (!claim.rows[0]) { await client.query('ROLLBACK'); return { granted: false, days: 0 }; }
    const agg = await client.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(reward_days), 0)::int AS earned FROM referrals
       WHERE referrer_id = $1 AND status = 'qualified'`, [referrerId]
    );
    const n = agg.rows[0].n; const earned = agg.rows[0].earned;
    const days = Math.max(0, totalDaysFor(n) - earned);
    if (days > 0) {
      await client.query(`UPDATE referrals SET reward_days = $2, reward_given = true WHERE id = $1`, [id, days]);
      // Extend the existing Pro-until field. GREATEST keeps a longer existing trial; never moves it back.
      await client.query(
        `UPDATE users SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, NOW()), NOW()) + ($2 || ' days')::interval,
                trial_emails = COALESCE(trial_emails, '{}'::jsonb) - 'd2' - 'd0'
         WHERE id = $1`, [referrerId, String(days)]
      );
    }
    await client.query('COMMIT');
    return { granted: days > 0, days, qualified: n };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { release(); }
}

async function tally(db, userId) {
  const u = await db.query('SELECT referral_code FROM users WHERE id = $1', [userId]);
  let code = u.rows[0] && u.rows[0].referral_code;
  if (!code && u.rows[0]) {
    // Legacy account without a code: mint one (unique constraint retries once).
    for (let i = 0; i < 3 && !code; i++) {
      const c = 'D' + Math.random().toString(36).slice(2, 8).toUpperCase();
      try {
        const r = await db.query('UPDATE users SET referral_code = $2 WHERE id = $1 AND referral_code IS NULL RETURNING referral_code', [userId, c]);
        code = r.rows[0] ? r.rows[0].referral_code : c;
      } catch (e) { /* collision: try again */ }
    }
  }
  const list = await db.query(
    `SELECT r.status, r.reward_days, r.qualified_at, r.created_at, f.email
     FROM referrals r JOIN users f ON f.id = r.referred_id
     WHERE r.referrer_id = $1 AND r.status <> 'rejected' ORDER BY r.created_at DESC LIMIT 100`, [userId]
  );
  const friends = list.rows.filter((r) => r.status === 'qualified').map((r) => ({ name: maskEmail(r.email), days: r.reward_days || 0 }));
  const waiting = list.rows.filter((r) => r.status === 'pending').length;
  const qualified = friends.length;
  const daysEarned = friends.reduce((s, f) => s + f.days, 0);
  const link = code ? linkFor('' + code) : null;
  return {
    code, link,
    share_text: link ? shareText(link) : null,
    qualified, waiting, days_earned: daysEarned,
    progress: progressLine(qualified),
    friends,
  };
}

module.exports = { NEED, BASE_DAYS, EXTRA_DAYS, CAP_DAYS, totalDaysFor, parseRef, hashSignal, normalizeEmail, maskEmail, linkFor, shareText, progressLine, recordPending, qualify, tally };
