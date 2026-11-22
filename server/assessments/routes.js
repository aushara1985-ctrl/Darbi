'use strict';
// Darbi assessments: HTTP layer.
//
// Mount (one line in server/index.js, after authMiddleware, db and rateLimit are defined):
//   require('./assessments/routes')(app, { authMiddleware, db, rateLimit, getIP });
//
// All endpoints live under /api/assess and need a logged-in user (Bearer JWT, same as the rest of Darbi).
// No endpoint here touches existing tables except a read of users.access_status for the plan tier.

const crypto = require('crypto');
const engine = require('./engine');
const S = require('./scoring');
const { memoryStore, pgStore } = require('./store');
const aiInterview = require('./aiInterview');
const { tracksCfg } = engine;

const TIER_ORDER = { free: 0, starter: 1, pro: 2 };

function newId() { return 'as_' + crypto.randomBytes(9).toString('hex'); }
const nowIso = () => new Date().toISOString();

module.exports = function mountAssessments(app, opts = {}) {
  const { authMiddleware, db, rateLimit, getIP } = opts;
  if (!app || typeof authMiddleware !== 'function') throw new Error('assessments: app and authMiddleware are required');
  const store = opts.store || (db ? pgStore(db) : memoryStore());
  const base = opts.base || '/api/assess';
  // Interview answers are read by GPT-4o. opts.interviewChat overrides the client (tests);
  // without a key the report is the structural check, labelled «التقييم المختصر».
  const interviewChat = () => (opts.interviewChat !== undefined ? opts.interviewChat : aiInterview.chatFromEnv());

  // Plan tier. Default: paid -> 'starter' (Darbi stores only free/paid today), unless users.plan exists.
  // Pass opts.getTier(req) => 'free'|'starter'|'pro' to override.
  const getTier = opts.getTier || (async (req) => {
    if (!db) return 'free';
    try {
      const { rows } = await db.query('SELECT access_status, plan FROM users WHERE id=$1', [req.user.id]);
      const r = rows[0] || {};
      if (r.access_status !== 'paid') return 'free';
      return ['starter', 'pro'].includes(r.plan) ? r.plan : (r.plan === 'lifetime' ? 'pro' : 'starter');
    } catch {
      try {
        const { rows } = await db.query('SELECT access_status FROM users WHERE id=$1', [req.user.id]);
        return rows[0] && rows[0].access_status === 'paid' ? 'starter' : 'free';
      } catch { return 'free'; }
    }
  });

  const limited = (key, max, win) => (req, res, next) => {
    if (typeof rateLimit !== 'function') return next();
    const ip = typeof getIP === 'function' ? getIP(req) : req.ip;
    return rateLimit(key + ':' + (req.user ? req.user.id : ip), max, win) ? next() : res.status(429).json({ error: 'rate_limited' });
  };
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error('[assess]', e); res.status(500).json({ error: 'server_error' }); });

  // optional auth for the catalog (anonymous = free tier view)
  const softAuth = (req, res, next) => {
    const stub = { status: () => ({ json: () => next() }) };
    authMiddleware(req, stub, next);
  };

  function allowed(tier, test) {
    const need = tracksCfg.tests[test].tier;
    return TIER_ORDER[tier] >= TIER_ORDER[need];
  }
  const publicTests = (tier) => Object.entries(tracksCfg.tests).map(([id, m]) => ({
    id, kind: m.kind, en: m.en, ar: m.ar, minutes: m.minutes, requiredTier: m.tier, unlocked: allowed(tier, id),
  }));

  // ── catalog ──────────────────────────────────────────────────────────────────
  app.get(base + '/catalog', softAuth, wrap(async (req, res) => {
    const tier = req.user ? await getTier(req) : 'free';
    res.json({
      success: true, tier, families: engine.FAMILIES, tests: publicTests(tier),
      tracks: Object.fromEntries(Object.entries(tracksCfg.tracks).map(([k, v]) => [k, { en: v.en, ar: v.ar, intro: v.intro, path: v.path, weeks: v.weeks }])),
      tierLimits: tracksCfg.tiers,
    });
  }));

  // ── start ────────────────────────────────────────────────────────────────────
  app.post(base + '/start', authMiddleware, limited('assess-start', 30, 3600_000), wrap(async (req, res) => {
    const b = req.body || {};
    const test = String(b.test || '');
    if (!tracksCfg.tests[test]) return res.status(400).json({ error: 'unknown_test' });
    const tier = await getTier(req);
    if (!allowed(tier, test)) return res.status(402).json({ error: 'upgrade_required', requiredTier: tracksCfg.tests[test].tier, tier });
    const lang = b.lang === 'en' ? 'en' : 'ar';
    const meta = tracksCfg.tests[test];
    if (meta.kind === 'interview' && lang === 'en' && !tracksCfg.tiers[tier].english_interview) {
      return res.status(402).json({ error: 'upgrade_required', feature: 'english_interview', requiredTier: 'pro', tier });
    }
    const timed = !!b.timed;
    if (timed && !tracksCfg.tiers[tier].timed) return res.status(402).json({ error: 'upgrade_required', feature: 'timed_mode', requiredTier: 'starter', tier });

    const past = await store.listByUser(req.user.id, 300);
    // Resume an unfinished session for the same test instead of burning another attempt.
    const open = past.find((s) => s.test === test && s.status === 'in_progress' && s.lang === lang && !expired(s));
    if (open) return res.json(sessionPayload(open, tier, true));

    const cutoff = Date.now() - 30 * 86400_000;
    const recent = past.filter((s) => s.test === test && new Date(s.createdAt).getTime() > cutoff).length;
    if (recent >= tracksCfg.tiers[tier].attemptsPer30d) return res.status(429).json({ error: 'attempt_limit', limit: tracksCfg.tiers[tier].attemptsPer30d, tier });

    const id = newId();
    const built = engine.buildSession({ test, track: b.track, lang, family: b.family, timed, sessionId: id });
    if (built.error) return res.status(400).json({ error: built.error });
    const row = {
      id, userId: req.user.id, test, kind: built.kind, track: built.track, family: built.family, lang: built.lang,
      status: 'in_progress', itemIds: built.itemIds, answers: {}, timeLimitSec: built.timeLimitSec,
      startedAt: nowIso(), createdAt: nowIso(),
    };
    await store.create(row);
    res.json(sessionPayload(row, tier, false));
  }));

  function expired(s) {
    if (s.timeLimitSec) return Date.now() > new Date(s.startedAt).getTime() + (s.timeLimitSec + 3600) * 1000;
    return Date.now() > new Date(s.startedAt).getTime() + 24 * 3600_000;
  }
  function sessionPayload(s, tier, resumed) {
    const meta = tracksCfg.tests[s.test];
    return {
      success: true, resumed, sessionId: s.id, test: s.test, kind: s.kind, title: { en: meta.en, ar: meta.ar },
      lang: s.lang, track: s.track, family: s.family, tier,
      itemCount: s.itemIds.length, items: s.itemIds.map(engine.publicItem),
      answers: s.answers || {}, timeLimitSec: s.timeLimitSec, startedAt: s.startedAt, serverTime: nowIso(),
    };
  }
  async function loadOwn(req, res) {
    const s = await store.get(req.params.id);
    if (!s || String(s.userId) !== String(req.user.id)) { res.status(404).json({ error: 'not_found' }); return null; }
    return s;
  }

  // ── resume / get items ───────────────────────────────────────────────────────
  app.get(base + '/session/:id', authMiddleware, wrap(async (req, res) => {
    const s = await loadOwn(req, res); if (!s) return;
    if (s.status !== 'in_progress') return res.status(409).json({ error: 'already_submitted', sessionId: s.id });
    res.json(sessionPayload(s, await getTier(req), true));
  }));

  // ── save one answer (autosave) ───────────────────────────────────────────────
  app.post(base + '/session/:id/answer', authMiddleware, limited('assess-ans', 600, 3600_000), wrap(async (req, res) => {
    const s = await loadOwn(req, res); if (!s) return;
    if (s.status !== 'in_progress') return res.status(409).json({ error: 'already_submitted' });
    const { id, value } = req.body || {};
    if (!s.itemIds.includes(id)) return res.status(400).json({ error: 'bad_item' });
    if (!validAnswer(id, value)) return res.status(400).json({ error: 'bad_value' });
    const answers = { ...(s.answers || {}), [id]: value };
    await store.update(s.id, { answers });
    res.json({ success: true, saved: Object.keys(answers).length, of: s.itemIds.length });
  }));

  // ── submit + score + report ──────────────────────────────────────────────────
  app.post(base + '/session/:id/submit', authMiddleware, limited('assess-submit', 60, 3600_000), wrap(async (req, res) => {
    const s = await loadOwn(req, res); if (!s) return;
    if (s.status !== 'in_progress') {
      return res.json({ success: true, alreadySubmitted: true, report: s.report });
    }
    const merged = { ...(s.answers || {}) };
    const incoming = (req.body && req.body.answers) || {};
    for (const [id, v] of Object.entries(incoming)) if (s.itemIds.includes(id) && validAnswer(id, v)) merged[id] = v;

    const usedSec = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 1000);
    const overtime = !!(s.timeLimitSec && usedSec > s.timeLimitSec + 15);
    const result = engine.grade(s, merged, { usedSec });
    if (result.kind === 'interview') {
      await aiInterview.applyToResult(s, merged, result, {
        chat: interviewChat(),
        role: String(s.family || '').replace(/_/g, ' '),
        onError: (e) => console.error('[assess] interview AI error:', String((e && e.message) || e).replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-***').slice(0, 160)),
      });
    }
    const report = engine.buildReport(s, result);
    if (result.kind === 'interview') { report.evaluator = result.evaluator; report.honestyNote = result.evaluatorNote; }
    report.timing = { usedSec, limitSec: s.timeLimitSec, overtime };
    const pct = typeof result.pct === 'number' ? result.pct : null;
    await store.update(s.id, { status: 'submitted', answers: merged, result, report, submittedAt: nowIso(), pct, overtime });
    const attempts = await store.listByUser(req.user.id, 300);
    res.json({ success: true, sessionId: s.id, report, readiness: S.readiness(toAttempts(attempts)) });
  }));

  app.get(base + '/session/:id/report', authMiddleware, wrap(async (req, res) => {
    const s = await loadOwn(req, res); if (!s) return;
    if (s.status !== 'submitted') return res.status(409).json({ error: 'not_submitted' });
    res.json({ success: true, sessionId: s.id, report: s.report });
  }));

  // ── progress + readiness + plan ──────────────────────────────────────────────
  app.get(base + '/progress', authMiddleware, wrap(async (req, res) => {
    const tier = await getTier(req);
    const all = await store.listByUser(req.user.id, 300);
    const done = all.filter((s) => s.status === 'submitted');
    const track = engine.normTrack(req.query.track);
    const path = tracksCfg.tracks[track].path;
    const completed = new Set(done.map((s) => s.test));
    const nextStep = path.find((t) => !completed.has(t)) || null;
    const days = [...new Set(done.map((s) => String(s.submittedAt || s.createdAt).slice(0, 10)))].sort().reverse();
    res.json({
      success: true, tier, track,
      readiness: S.readiness(toAttempts(done)),
      plan: path.map((t) => ({ test: t, done: completed.has(t), unlocked: allowed(tier, t), title: { en: tracksCfg.tests[t].en, ar: tracksCfg.tests[t].ar } })),
      nextStep,
      history: done.slice(0, 30).map((s) => ({ sessionId: s.id, test: s.test, lang: s.lang, pct: s.pct == null ? null : Number(s.pct), submittedAt: s.submittedAt })),
      activeDays: days.slice(0, 30), attemptsDone: done.length,
    });
  }));

  function toAttempts(rows) {
    return rows.filter((s) => s.status === 'submitted' && s.pct != null).map((s) => ({ test: s.test, pct: Number(s.pct), createdAt: s.submittedAt || s.createdAt, lang: s.lang }));
  }

  function validAnswer(id, v) {
    const it = engine.LOOKUP.get(id); if (!it) return false;
    if (it.type === 'likert') return Number.isInteger(v) && v >= 1 && v <= 5;
    if (it.type === 'mcq') { const n = it.verbal ? 3 : it.opts.length; return Number.isInteger(v) && v >= 0 && v < n; }
    if (it.type === 'sjt') return !!v && Number.isInteger(v.most) && Number.isInteger(v.least) && v.most !== v.least && v.most >= 0 && v.least >= 0 && v.most < it.opts.length && v.least < it.opts.length;
    if (it.type === 'interview') {
      if (typeof v === 'string') return v.length <= 6000;
      return !!v && typeof v.text === 'string' && v.text.length <= 6000;
    }
    return false;
  }

  return { store, getTier };
};
module.exports.TIER_ORDER = TIER_ORDER;
