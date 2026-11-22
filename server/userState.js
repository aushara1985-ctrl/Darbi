// ══════ Per-user saved state ═══════════════════════════════════════════════
// The CV, the written CV, the applications tracker, the diagnosis, practice
// results and the progress timeline used to live only in the browser. They
// are now saved per account in Postgres (table user_state, one row per
// user + kind) so a person who signs in on another device sees their data.
// The browser keeps a local cache and syncs through these routes.
//
//   GET    /api/darbi/state            → every kind the account has
//   PUT    /api/darbi/state/:kind      → save one kind  { data }
//   POST   /api/darbi/state/batch      → save several   { items: { kind: data } }
//   DELETE /api/darbi/state/:kind      → remove one kind
//
// All routes require the account token. A person only ever reads or writes
// their own rows (user id comes from the token, never from the request).

// kind → max stored size in bytes. Anything not listed is refused.
const KINDS = {
  diagnosis:          150 * 1024, // includes the CV text the diagnosis was built from
  cv:                  80 * 1024,
  cv_writer:          200 * 1024, // the written CV (AR/EN), answers and source text
  applications:       250 * 1024,
  timeline:            80 * 1024, // progress timeline (DarbiBrain events)
  journey:             20 * 1024,
  draft:              100 * 1024,
  interview_progress: 100 * 1024,
  interview_evals:    250 * 1024,
};

function isKind(kind) {
  return Object.prototype.hasOwnProperty.call(KINDS, kind);
}

// Returns { ok, json } or { ok:false, error, message }.
function validate(kind, data) {
  if (!isKind(kind)) return { ok: false, error: 'unknown_kind', message: 'نوع بيانات غير معروف.' };
  if (data === null || typeof data !== 'object') return { ok: false, error: 'bad_data', message: 'البيانات لازم تكون كائن أو قائمة.' };
  let json;
  try { json = JSON.stringify(data); } catch (e) { return { ok: false, error: 'bad_data', message: 'تعذر قراءة البيانات.' }; }
  if (Buffer.byteLength(json, 'utf8') > KINDS[kind]) return { ok: false, error: 'too_large', message: 'البيانات أكبر من الحد المسموح.' };
  return { ok: true, json };
}

async function loadState(db, userId) {
  const { rows } = await db.query('SELECT kind, data, updated_at FROM user_state WHERE user_id = $1', [userId]);
  const state = {};
  for (const r of rows) {
    if (!isKind(r.kind)) continue;
    state[r.kind] = { data: r.data, updatedAt: new Date(r.updated_at).toISOString() };
  }
  return state;
}

async function saveState(db, userId, kind, data) {
  const v = validate(kind, data);
  if (!v.ok) return v;
  const { rows } = await db.query(
    `INSERT INTO user_state (user_id, kind, data, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (user_id, kind) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
     RETURNING updated_at`,
    [userId, kind, v.json]
  );
  return { ok: true, updatedAt: new Date(rows[0].updated_at).toISOString() };
}

async function deleteState(db, userId, kind) {
  if (!isKind(kind)) return { ok: false, error: 'unknown_kind', message: 'نوع بيانات غير معروف.' };
  await db.query('DELETE FROM user_state WHERE user_id = $1 AND kind = $2', [userId, kind]);
  return { ok: true };
}

function register(app, deps) {
  const { authMiddleware, db, rateLimit } = deps;
  const limited = (req, res, max) => {
    if (rateLimit && !rateLimit('state:u' + req.user.id, max, 3600_000)) {
      res.status(429).json({ success: false, error: 'rate_limit', message: 'طلبات كثيرة. جرّب بعد شوي.' });
      return true;
    }
    return false;
  };
  const fail = (res, e, where) => {
    console.error('[state] ' + where + ' failed:', e.message);
    res.status(500).json({ success: false, error: 'state_failed', message: 'ما قدرنا نحفظ بياناتك الحين. بياناتك باقية على جهازك ونعيد المحاولة.' });
  };

  app.get('/api/darbi/state', authMiddleware, async (req, res) => {
    if (limited(req, res, 600)) return;
    try { res.json({ success: true, state: await loadState(db, req.user.id) }); }
    catch (e) { fail(res, e, 'load'); }
  });

  app.post('/api/darbi/state/batch', authMiddleware, async (req, res) => {
    if (limited(req, res, 600)) return;
    const items = (req.body && req.body.items && typeof req.body.items === 'object') ? req.body.items : null;
    if (!items) return res.status(400).json({ success: false, error: 'bad_data', message: 'ما فيه بيانات للحفظ.' });
    const saved = {}, errors = {};
    try {
      for (const kind of Object.keys(items).slice(0, 12)) {
        const r = await saveState(db, req.user.id, kind, items[kind]);
        if (r.ok) saved[kind] = r.updatedAt; else errors[kind] = r.error;
      }
      res.json({ success: true, saved, errors });
    } catch (e) { fail(res, e, 'batch'); }
  });

  app.put('/api/darbi/state/:kind', authMiddleware, async (req, res) => {
    if (limited(req, res, 600)) return;
    try {
      const r = await saveState(db, req.user.id, req.params.kind, req.body && req.body.data);
      if (!r.ok) return res.status(r.error === 'too_large' ? 413 : 400).json({ success: false, error: r.error, message: r.message });
      res.json({ success: true, updatedAt: r.updatedAt });
    } catch (e) { fail(res, e, 'save'); }
  });

  app.delete('/api/darbi/state/:kind', authMiddleware, async (req, res) => {
    if (limited(req, res, 600)) return;
    try {
      const r = await deleteState(db, req.user.id, req.params.kind);
      if (!r.ok) return res.status(400).json({ success: false, error: r.error, message: r.message });
      res.json({ success: true });
    } catch (e) { fail(res, e, 'delete'); }
  });
}

module.exports = { KINDS, isKind, validate, loadState, saveState, deleteState, register };
