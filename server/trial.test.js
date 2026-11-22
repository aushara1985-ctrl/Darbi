'use strict';
const test = require('node:test');
const assert = require('node:assert');
const t = require('./trial');

test('active trial reads as paid, expired and legacy users do not', () => {
  const now = Date.now();
  const base = { id: 1, email: 'a@b.c', access_status: 'free', referral_code: 'X' };
  const active = t.publicUser({ ...base, trial_ends_at: new Date(now + 3 * 864e5) }, now);
  assert.strictEqual(active.paid, true);
  assert.strictEqual(active.trial.days_left, 3);
  const expired = t.publicUser({ ...base, trial_ends_at: new Date(now - 1000) }, now);
  assert.strictEqual(expired.paid, false);
  assert.strictEqual(expired.trial.expired, true);
  const legacy = t.publicUser({ ...base, trial_ends_at: null }, now);
  assert.strictEqual(legacy.paid, false);
  assert.strictEqual(legacy.trial.expired, false);
});

test('email is skipped silently without key or verified-domain flag', async () => {
  assert.strictEqual(t.emailEnabled({}), false);
  assert.strictEqual(t.emailEnabled({ RESEND_API_KEY: 'k' }), false);
  assert.strictEqual(t.emailEnabled({ RESEND_API_KEY: 'k', EMAIL_DOMAIN_VERIFIED: '1' }), true);
  assert.strictEqual(await t.sendEmail('a@b.c', 's', 'h', {}), false);
});

test('sendOnce is idempotent: second claim is refused', async () => {
  let claimed = false; let sends = 0;
  const db = { query: async (sql) => (/RETURNING/.test(sql) ? (claimed ? { rows: [] } : ((claimed = true), { rows: [{ id: 1 }] })) : { rows: [] }) };
  const env = { RESEND_API_KEY: 'k', EMAIL_DOMAIN_VERIFIED: '1' };
  const send = async () => { sends++; return true; };
  assert.strictEqual(await t.sendOnce(db, 1, 'a@b.c', 'welcome', { env, send }), true);
  assert.strictEqual(await t.sendOnce(db, 1, 'a@b.c', 'welcome', { env, send }), false);
  assert.strictEqual(sends, 1);
});
