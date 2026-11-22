'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('./referral');

// Tiny in-memory stand-in for the few queries referral.js runs.
function fakeDb(users) {
  const state = { users, referrals: [], nextId: 1, extended: [] };
  const q = async (sql, p = []) => {
    sql = sql.replace(/\s+/g, ' ');
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
    if (/FROM users WHERE referral_code/.test(sql)) return { rows: state.users.filter((u) => u.referral_code === p[0]).map((u) => ({ ...u })) };
    if (/SELECT 1 FROM referrals WHERE referred_id/.test(sql)) return { rows: state.referrals.filter((r) => r.referred_id === p[0]).slice(0, 1).map(() => ({ '?column?': 1 })) };
    if (/SELECT 1 FROM referrals WHERE referrer_id = \$1 AND referred_device_hash/.test(sql)) return { rows: state.referrals.filter((r) => r.referrer_id === p[0] && r.referred_device_hash === p[1] && r.status !== 'rejected').slice(0, 1).map(() => ({})) };
    if (/^INSERT INTO referrals/.test(sql)) {
      if (state.referrals.some((r) => r.referrer_id === p[0] && r.referred_id === p[1])) return { rows: [] };
      const row = { id: state.nextId++, referrer_id: p[0], referred_id: p[1], status: p[2], reject_reason: p[3], referred_ip_hash: p[4], referred_device_hash: p[5], reward_days: 0 };
      state.referrals.push(row); return { rows: [{ id: row.id }] };
    }
    if (/SELECT id, referrer_id FROM referrals WHERE referred_id = \$1 AND status = 'pending'/.test(sql)) return { rows: state.referrals.filter((r) => r.referred_id === p[0] && r.status === 'pending').slice(0, 1) };
    if (/FOR UPDATE/.test(sql)) return { rows: [{ id: p[0] }] };
    if (/UPDATE referrals SET status = 'qualified'/.test(sql)) {
      const r = state.referrals.find((x) => x.id === p[0] && x.status === 'pending');
      if (!r) return { rows: [] }; r.status = 'qualified'; return { rows: [{ id: r.id }] };
    }
    if (/SELECT COUNT/.test(sql)) {
      const l = state.referrals.filter((r) => r.referrer_id === p[0] && r.status === 'qualified');
      return { rows: [{ n: l.length, earned: l.reduce((s, r) => s + r.reward_days, 0) }] };
    }
    if (/UPDATE referrals SET reward_days/.test(sql)) { state.referrals.find((r) => r.id === p[0]).reward_days = p[1]; return { rows: [] }; }
    if (/UPDATE users SET trial_ends_at/.test(sql)) {
      const u = state.users.find((x) => x.id === p[0]);
      const now = Date.now(); const cur = u.trial_ends_at ? new Date(u.trial_ends_at).getTime() : now;
      const before = u.trial_ends_at ? new Date(u.trial_ends_at).getTime() : null;
      u.trial_ends_at = new Date(Math.max(cur, now) + Number(p[1]) * 864e5);
      state.extended.push({ before, after: u.trial_ends_at.getTime() });
      return { rows: [] };
    }
    throw new Error('unexpected sql: ' + sql);
  };
  return { query: q, state };
}

const mkUsers = () => [
  { id: 1, email: 'ali@x.com', referral_code: 'ABC123', device_hash: R.hashSignal('dev-ali', 's'), trial_ends_at: null },
  { id: 2, email: 'f2@x.com', referral_code: 'F2' }, { id: 3, email: 'f3@x.com', referral_code: 'F3' },
  { id: 4, email: 'f4@x.com', referral_code: 'F4' }, { id: 5, email: 'f5@x.com', referral_code: 'F5' },
];
const rec = (db, id, extra = {}) => R.recordPending(db, { referredId: id, referredEmail: 'f' + id + '@x.com', rawCode: 'u-abc123', ip: '1.1.1.' + id, device: 'dev-' + id, salt: 's', ...extra });

test('reward schedule: 2 friends = 7, then +3 each, capped at 30', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4].map(R.totalDaysFor), [0, 0, 7, 10, 13]);
  assert.strictEqual(R.totalDaysFor(100), 30);
  assert.strictEqual(R.totalDaysFor(9), 28);
  assert.strictEqual(R.totalDaysFor(10), 30);
});

test('link code parsing and masking', () => {
  assert.strictEqual(R.parseRef('u-abc123'), 'ABC123');
  assert.strictEqual(R.parseRef(' D9XYZ1 '), 'D9XYZ1');
  assert.strictEqual(R.parseRef('<script>'), null);
  assert.strictEqual(R.maskEmail('sara.k@gmail.com'), 'sa•••');
  assert.ok(R.linkFor('ABC123').endsWith('/?ref=u-ABC123'));
  assert.ok(!R.shareText('x').includes('darbi.ai'));
});

test('signup alone gives nothing; first friend gives nothing; second gives 7 days; third +3', async () => {
  const db = fakeDb(mkUsers());
  for (const id of [2, 3, 4]) assert.strictEqual((await rec(db, id)).recorded, true);
  assert.strictEqual(db.state.users[0].trial_ends_at, null);
  assert.strictEqual((await R.qualify(db, 2)).granted, false);
  assert.strictEqual(db.state.users[0].trial_ends_at, null);
  const second = await R.qualify(db, 3);
  assert.strictEqual(second.days, 7);
  const third = await R.qualify(db, 4);
  assert.strictEqual(third.days, 3);
  const left = (db.state.users[0].trial_ends_at.getTime() - Date.now()) / 864e5;
  assert.ok(left > 9.9 && left <= 10.01, 'total 10 days, got ' + left);
});

test('idempotent: re-qualifying the same friend never pays twice', async () => {
  const db = fakeDb(mkUsers());
  await rec(db, 2); await rec(db, 3);
  await R.qualify(db, 2); await R.qualify(db, 3);
  const before = db.state.users[0].trial_ends_at.getTime();
  for (let i = 0; i < 3; i++) assert.strictEqual((await R.qualify(db, 3)).granted, false);
  assert.strictEqual(db.state.users[0].trial_ends_at.getTime(), before);
  assert.strictEqual((await rec(db, 3)).recorded, false); // cannot be re-attached to anyone
});

test('self referral, same email alias and same device are rejected and earn nothing', async () => {
  const db = fakeDb(mkUsers());
  assert.strictEqual((await rec(db, 1)).reason, 'self');
  assert.strictEqual((await R.recordPending(db, { referredId: 9, referredEmail: 'Ali+1@x.com', rawCode: 'u-abc123', salt: 's', device: 'd9' })).reason, 'same_email');
  assert.strictEqual((await rec(db, 2, { device: 'dev-ali' })).reason, 'same_device');
  await rec(db, 3, { device: 'shared' });
  assert.strictEqual((await rec(db, 4, { device: 'shared' })).reason, 'same_device');
  assert.strictEqual((await R.qualify(db, 2)).granted, false);
  assert.strictEqual(db.state.users[0].trial_ends_at, null);
});

test('never reduces access: a longer existing trial is only extended; cap holds at 30', async () => {
  const users = mkUsers(); users[0].trial_ends_at = new Date(Date.now() + 20 * 864e5);
  const db = fakeDb(users);
  await rec(db, 2); await rec(db, 3);
  await R.qualify(db, 2); await R.qualify(db, 3);
  assert.ok(db.state.extended.every((e) => e.after > e.before));
  assert.ok((users[0].trial_ends_at.getTime() - Date.now()) / 864e5 > 26.9);
  // 40 more friends: total earned stops at 30
  for (let id = 100; id < 140; id++) { db.state.users.push({ id, email: 'g' + id + '@x.com', referral_code: 'G' + id }); await R.recordPending(db, { referredId: id, referredEmail: 'g' + id + '@x.com', rawCode: 'u-abc123', salt: 's', device: 'd' + id }); await R.qualify(db, id); }
  const earned = db.state.referrals.reduce((s, r) => s + r.reward_days, 0);
  assert.strictEqual(earned, 30);
});

test('progress line is honest and plain', () => {
  assert.strictEqual(R.progressLine(1), 'دعيت 1 من 2 — باقي واحد وتاخذ أسبوع Pro');
  assert.ok(!/\$|دولار|عمولة|ريال|30|60/.test(R.progressLine(5) + R.shareText('x')));
});
