'use strict';
// Session store. Memory by default (tests, local dev); Postgres when a `db` (pg Pool) is passed.
// Table is created lazily with CREATE TABLE IF NOT EXISTS: no migration step needed.

function memoryStore() {
  const rows = new Map();
  return {
    kind: 'memory',
    async init() {},
    async create(s) { rows.set(s.id, { ...s }); return s; },
    async get(id) { const r = rows.get(id); return r ? { ...r } : null; },
    async update(id, patch) { const r = rows.get(id); if (!r) return null; Object.assign(r, patch); return { ...r }; },
    async listByUser(userId, limit = 200) {
      return [...rows.values()].filter((r) => String(r.userId) === String(userId))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);
    },
  };
}

function pgStore(db) {
  let ready = null;
  const map = (r) => r && ({
    id: r.id, userId: r.user_id, test: r.test, kind: r.kind, track: r.track, family: r.family, lang: r.lang,
    status: r.status, itemIds: r.item_ids, answers: r.answers || {}, result: r.result || null, report: r.report || null,
    timeLimitSec: r.time_limit_sec, startedAt: r.started_at, submittedAt: r.submitted_at, createdAt: r.created_at,
    pct: r.pct, overtime: r.overtime,
  });
  return {
    kind: 'pg',
    init() {
      if (!ready) {
        ready = db.query(`CREATE TABLE IF NOT EXISTS assessment_sessions (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, test TEXT NOT NULL, kind TEXT, track TEXT, family TEXT, lang TEXT,
          status TEXT NOT NULL DEFAULT 'in_progress', item_ids JSONB NOT NULL, answers JSONB NOT NULL DEFAULT '{}'::jsonb,
          result JSONB, report JSONB, time_limit_sec INT, started_at TIMESTAMPTZ, submitted_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), pct NUMERIC, overtime BOOLEAN DEFAULT FALSE)`)
          .then(() => db.query('CREATE INDEX IF NOT EXISTS assessment_sessions_user_idx ON assessment_sessions (user_id, created_at DESC)'));
      }
      return ready;
    },
    async create(s) {
      await this.init();
      await db.query(`INSERT INTO assessment_sessions (id,user_id,test,kind,track,family,lang,status,item_ids,answers,time_limit_sec,started_at,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13)`,
        [s.id, String(s.userId), s.test, s.kind, s.track, s.family, s.lang, s.status, JSON.stringify(s.itemIds), JSON.stringify(s.answers || {}), s.timeLimitSec, s.startedAt, s.createdAt]);
      return s;
    },
    async get(id) { await this.init(); const { rows } = await db.query('SELECT * FROM assessment_sessions WHERE id=$1', [id]); return map(rows[0]); },
    async update(id, p) {
      await this.init();
      const cols = { status: 'status', answers: 'answers', result: 'result', report: 'report', submittedAt: 'submitted_at', pct: 'pct', overtime: 'overtime' };
      const sets = [], vals = [id];
      for (const [k, c] of Object.entries(cols)) if (k in p) { vals.push(['answers', 'result', 'report'].includes(k) ? JSON.stringify(p[k]) : p[k]); sets.push(`${c}=$${vals.length}${['answers', 'result', 'report'].includes(k) ? '::jsonb' : ''}`); }
      if (!sets.length) return this.get(id);
      const { rows } = await db.query(`UPDATE assessment_sessions SET ${sets.join(',')} WHERE id=$1 RETURNING *`, vals);
      return map(rows[0]);
    },
    async listByUser(userId, limit = 200) {
      await this.init();
      const { rows } = await db.query('SELECT * FROM assessment_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [String(userId), limit]);
      return rows.map(map);
    },
  };
}

module.exports = { memoryStore, pgStore };
