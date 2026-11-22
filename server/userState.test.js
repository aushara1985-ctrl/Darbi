// Per-user saved state: only known kinds, size caps, strict per-user isolation,
// and the additive migration. Uses an in-memory stand-in for the user_state
// table. Run: node --test server/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const us = require('./userState');

// Minimal fake of the three statements the module runs.
function fakeDb() {
  const rows = new Map(); // "user|kind" -> { user_id, kind, data, updated_at }
  let tick = 0;
  return {
    rows,
    async query(sql, params) {
      if (/^SELECT kind, data, updated_at FROM user_state/.test(sql)) {
        return { rows: Array.from(rows.values()).filter(r => r.user_id === params[0]) };
      }
      if (/^INSERT INTO user_state/.test(sql.trim())) {
        const [user_id, kind, json] = params;
        const row = { user_id, kind, data: JSON.parse(json), updated_at: new Date(Date.UTC(2026, 10, 23, 0, 0, ++tick)) };
        rows.set(user_id + '|' + kind, row);
        return { rows: [{ updated_at: row.updated_at }] };
      }
      if (/^DELETE FROM user_state/.test(sql)) {
        rows.delete(params[0] + '|' + params[1]);
        return { rows: [] };
      }
      throw new Error('unexpected sql: ' + sql);
    },
  };
}

test('kinds cover the CV, the written CV, the tracker, the diagnosis, practice and the timeline', () => {
  for (const k of ['diagnosis', 'cv', 'cv_writer', 'applications', 'timeline', 'interview_evals', 'interview_progress', 'journey', 'draft']) {
    assert.ok(us.isKind(k), k);
  }
  assert.ok(!us.isKind('password'));
  assert.ok(!us.isKind('__proto__'));
  assert.ok(!us.isKind('constructor'));
});

test('validate: refuses unknown kinds, non-objects and oversized data', () => {
  assert.strictEqual(us.validate('nope', {}).error, 'unknown_kind');
  assert.strictEqual(us.validate('cv', 'text').error, 'bad_data');
  assert.strictEqual(us.validate('cv', null).error, 'bad_data');
  assert.strictEqual(us.validate('journey', { x: 'a'.repeat(30 * 1024) }).error, 'too_large');
  assert.ok(us.validate('applications', [{ id: 'app-1', company: 'TEST Co' }]).ok);
});

test('save then load on "another device" returns the same data', async () => {
  const db = fakeDb();
  const apps = [{ id: 'app-1', company: 'TEST Co', role: 'Accountant', status: 'applied' }];
  const cv = { result: { cv: { ar: { name: 'TEST سارة' } } }, templateId: 'graduate' };
  const diag = { dreamRole: 'محاسب', supportingScores: { cvStrength: 71 }, analysis: { source: 'ai' } };
  assert.ok((await us.saveState(db, 7, 'applications', apps)).ok);
  assert.ok((await us.saveState(db, 7, 'cv_writer', cv)).ok);
  const saved = await us.saveState(db, 7, 'diagnosis', diag);
  assert.ok(saved.ok && /^2026-/.test(saved.updatedAt));
  // a fresh client (nothing local) signs in as user 7 and loads:
  const state = await us.loadState(db, 7);
  assert.deepStrictEqual(state.applications.data, apps);
  assert.deepStrictEqual(state.cv_writer.data, cv);
  assert.deepStrictEqual(state.diagnosis.data, diag);
  assert.ok(state.diagnosis.updatedAt);
});

test('isolation: one account never sees or overwrites another account\'s data', async () => {
  const db = fakeDb();
  await us.saveState(db, 1, 'applications', [{ id: 'a', company: 'TEST One' }]);
  await us.saveState(db, 2, 'applications', [{ id: 'b', company: 'TEST Two' }]);
  assert.deepStrictEqual((await us.loadState(db, 1)).applications.data, [{ id: 'a', company: 'TEST One' }]);
  assert.deepStrictEqual((await us.loadState(db, 2)).applications.data, [{ id: 'b', company: 'TEST Two' }]);
  assert.deepStrictEqual(await us.loadState(db, 3), {});
  await us.deleteState(db, 1, 'applications');
  assert.deepStrictEqual(await us.loadState(db, 1), {});
  assert.ok((await us.loadState(db, 2)).applications, 'deleting user 1 leaves user 2 untouched');
});

test('saving again replaces the row and moves updatedAt forward', async () => {
  const db = fakeDb();
  const a = await us.saveState(db, 5, 'cv', { templateId: 'classic' });
  const b = await us.saveState(db, 5, 'cv', { templateId: 'executive' });
  assert.ok(b.updatedAt > a.updatedAt);
  assert.strictEqual(db.rows.size, 1);
  assert.strictEqual((await us.loadState(db, 5)).cv.data.templateId, 'executive');
});

test('a refused save writes nothing', async () => {
  const db = fakeDb();
  const r = await us.saveState(db, 5, 'secrets', { a: 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(db.rows.size, 0);
});

test('routes: every state route sits behind the account token and uses the token\'s user id', async () => {
  const routes = [];
  const app = { get: (...a) => routes.push(['GET', ...a]), put: (...a) => routes.push(['PUT', ...a]), post: (...a) => routes.push(['POST', ...a]), delete: (...a) => routes.push(['DELETE', ...a]) };
  const authMiddleware = function auth() {};
  const db = fakeDb();
  us.register(app, { authMiddleware, db, rateLimit: () => true });
  assert.strictEqual(routes.length, 4);
  for (const r of routes) assert.strictEqual(r[2], authMiddleware, r[0] + ' ' + r[1] + ' must require auth');
  // PUT handler: body tries to smuggle another user id; the token's id is what is used.
  const put = routes.find(r => r[0] === 'PUT')[3];
  let out;
  const res = { status() { return this; }, json(o) { out = o; } };
  await put({ user: { id: 42 }, params: { kind: 'cv' }, body: { data: { templateId: 'classic' }, user_id: 1, userId: 1 } }, res);
  assert.strictEqual(out.success, true);
  assert.ok(db.rows.has('42|cv'));
  assert.ok(!db.rows.has('1|cv'));
});

test('migration is additive: CREATE TABLE IF NOT EXISTS user_state, nothing dropped', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'schema.sql'), 'utf8');
  assert.ok(/CREATE TABLE IF NOT EXISTS user_state/.test(sql));
  assert.ok(/PRIMARY KEY \(user_id, kind\)/.test(sql));
  assert.ok(!/\bDROP\s+(TABLE|COLUMN)\b/i.test(sql), 'schema.sql must stay additive');
});
