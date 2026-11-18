'use strict';
// Run: node --test server/billing/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('./plans');

// Tiny in-memory stand-in for the three queries plans.js uses (matched by SQL shape).
function fakeDb(users = {}) {
  const audit = [];
  const db = {
    users, audit,
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (q.startsWith('UPDATE users SET access_status = \'paid\'')) {
        const u = users[params[0]]; if (!u) return { rows: [] };
        u.access_status = 'paid'; u.paid_at = u.paid_at || 'now';
        u.plan = u.plan === 'lifetime' ? u.plan : (params[1] != null ? params[1] : u.plan);
        return { rows: [] };
      }
      if (q.startsWith('INSERT INTO access_audit')) {
        audit.push({ user_id: params[0], source: q.includes("'free'") ? 'stripe_webhook' : params[1], to: q.includes("'free'") ? 'free' : 'paid', note: q.includes("'free'") ? params[1] : params[3] });
        return { rows: [] };
      }
      if (q.startsWith('SELECT plan FROM users')) return { rows: users[params[0]] ? [{ plan: users[params[0]].plan || null }] : [] };
      if (q.startsWith('SELECT 1 FROM access_audit')) return { rows: audit.some((a) => String(a.user_id) === String(params[0]) && a.note === 'plan:lifetime') ? [{}] : [] };
      if (q.startsWith("UPDATE users SET access_status = 'free'")) {
        const u = users[params[0]]; if (u && u.access_status === 'paid') { u.access_status = 'free'; u.plan = null; } return { rows: [] };
      }
      if (q.startsWith('UPDATE users SET plan = $2')) {
        const u = users[params[0]]; if (u && u.access_status === 'paid' && u.plan !== 'lifetime') u.plan = params[1]; return { rows: [] };
      }
      if (q.startsWith('SELECT id FROM users WHERE lower(email)')) {
        const hit = Object.entries(users).find(([, u]) => u.email === String(params[0]).toLowerCase());
        return { rows: hit ? [{ id: Number(hit[0]) }] : [] };
      }
      throw new Error('unexpected SQL: ' + q.slice(0, 80));
    },
  };
  return db;
}
const checkout = (userId, plan, extra = {}) => ({ type: 'checkout.session.completed', data: { object: { id: 'cs_' + userId + plan, metadata: { userId: String(userId), plan }, ...extra } } });
const subEvent = (type, userId, status = 'canceled', extra = {}) => ({ type, data: { object: { id: 'sub_1', status, metadata: userId ? { userId: String(userId) } : {}, ...extra } } });
const quiet = { error() {} };

test('resolvePlan: metadata first, then price id, then amount; junk is null', () => {
  assert.equal(P.resolvePlan({ metadata: { plan: 'pro' } }), 'pro');
  const env = { STRIPE_PRICE_STARTER_MONTHLY: 'price_s', STRIPE_PRICE_PRO_MONTHLY: 'price_p', STRIPE_PRICE_FOUNDER_LIFETIME: 'price_l' };
  assert.equal(P.resolvePlan({ line_items: { data: [{ price: { id: 'price_p' } }] } }, env), 'pro');
  assert.equal(P.resolvePlan({ items: { data: [{ price: { id: 'price_s' } }] } }, env), 'starter');
  assert.equal(P.resolvePlan({ line_items: { data: [{ price: { id: 'price_l' } }] } }, env), 'lifetime');
  assert.equal(P.resolvePlan({ amount_total: 1900 }, {}), 'pro');
  assert.equal(P.resolvePlan({ amount_total: 19900 }, {}), 'lifetime');
  assert.equal(P.resolvePlan({ metadata: { plan: 'hacker' } }, {}), null);
  assert.equal(P.resolvePlan(null, {}), null);
});

test('checkout -> plan stored (starter, pro, lifetime)', async () => {
  for (const plan of ['starter', 'pro', 'lifetime']) {
    const db = fakeDb({ 1: { email: 'a@x.com', access_status: 'free', plan: null } });
    await P.handleEvent(db, checkout(1, plan), { log: quiet });
    assert.equal(db.users[1].access_status, 'paid');
    assert.equal(db.users[1].plan, plan);
    assert.equal(db.audit[0].note, 'plan:' + plan);
    assert.equal(db.audit[0].source, 'stripe_webhook');
  }
});

test('checkout with only the price id (no metadata.plan) still stores the plan', async () => {
  const db = fakeDb({ 1: { access_status: 'free' } });
  const ev = { type: 'checkout.session.completed', data: { object: { id: 'cs_x', metadata: { userId: '1' }, line_items: { data: [{ price: { id: 'price_p' } }] } } } };
  const prev = process.env.STRIPE_PRICE_PRO_MONTHLY; process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_p';
  try { await P.handleEvent(db, ev, { log: quiet }); } finally { if (prev === undefined) delete process.env.STRIPE_PRICE_PRO_MONTHLY; else process.env.STRIPE_PRICE_PRO_MONTHLY = prev; }
  assert.equal(db.users[1].plan, 'pro');
});

test('checkout without userId does nothing', async () => {
  const db = fakeDb({ 1: { access_status: 'free' } });
  await P.handleEvent(db, { type: 'checkout.session.completed', data: { object: { id: 'cs', metadata: {} } } }, { log: quiet });
  assert.equal(db.users[1].access_status, 'free'); assert.equal(db.audit.length, 0);
});

test('cancel -> revoke (deleted, canceled, unpaid); plan cleared', async () => {
  for (const [type, status] of [['customer.subscription.deleted', 'canceled'], ['customer.subscription.updated', 'canceled'], ['customer.subscription.updated', 'unpaid'], ['customer.subscription.updated', 'incomplete_expired']]) {
    const db = fakeDb({ 1: { access_status: 'paid', plan: 'pro' } });
    await P.handleEvent(db, subEvent(type, 1, status), { log: quiet });
    assert.equal(db.users[1].access_status, 'free', type + ' ' + status);
    assert.equal(db.users[1].plan, null);
    assert.ok(db.audit.some((a) => a.to === 'free' && a.note.startsWith('subscription_')));
  }
});

test('active subscription update does NOT revoke and follows a Starter -> Pro portal change', async () => {
  const db = fakeDb({ 1: { access_status: 'paid', plan: 'starter' } });
  process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_p';
  try {
    await P.handleEvent(db, subEvent('customer.subscription.updated', 1, 'active', { items: { data: [{ price: { id: 'price_p' } }] }, metadata: { userId: '1', plan: 'starter' } }), { log: quiet });
  } finally { delete process.env.STRIPE_PRICE_PRO_MONTHLY; }
  assert.equal(db.users[1].access_status, 'paid');
  assert.equal(db.users[1].plan, 'pro');
});

test('lifetime is never revoked (plan column OR audit trail)', async () => {
  let db = fakeDb({ 1: { access_status: 'paid', plan: 'lifetime' } });
  await P.handleEvent(db, subEvent('customer.subscription.deleted', 1), { log: quiet });
  assert.equal(db.users[1].access_status, 'paid'); assert.equal(db.users[1].plan, 'lifetime');

  // legacy lifetime buyer: only the audit row exists, plan column empty
  db = fakeDb({ 2: { access_status: 'paid', plan: null } });
  db.audit.push({ user_id: 2, note: 'plan:lifetime' });
  await P.handleEvent(db, subEvent('customer.subscription.updated', 2, 'unpaid'), { log: quiet });
  assert.equal(db.users[2].access_status, 'paid');
});

test('lifetime buyer who later buys a monthly plan keeps lifetime; monthly buyer upgrading to lifetime gets it', async () => {
  let db = fakeDb({ 1: { access_status: 'paid', plan: 'lifetime' } });
  await P.handleEvent(db, checkout(1, 'starter'), { log: quiet });
  assert.equal(db.users[1].plan, 'lifetime');
  db = fakeDb({ 1: { access_status: 'paid', plan: 'starter' } });
  await P.handleEvent(db, checkout(1, 'lifetime'), { log: quiet });
  assert.equal(db.users[1].plan, 'lifetime');
  await P.handleEvent(db, subEvent('customer.subscription.deleted', 1), { log: quiet });
  assert.equal(db.users[1].access_status, 'paid', 'old monthly sub ending after the Founder purchase must not revoke');
});

test('old subscriptions without metadata are found by customer email', async () => {
  const db = fakeDb({ 7: { email: 'old@x.com', access_status: 'paid', plan: 'starter' } });
  const stripe = { customers: { retrieve: async () => ({ email: 'Old@x.com'.toLowerCase() }) } };
  await P.handleEvent(db, subEvent('customer.subscription.deleted', null, 'canceled', { customer: 'cus_1' }), { stripe, log: quiet });
  assert.equal(db.users[7].access_status, 'free');
});

test('session-verify path: grantPlan stores plan with the verify source', async () => {
  const db = fakeDb({ 1: { access_status: 'free' } });
  await P.grantPlan(db, 1, P.resolvePlan({ metadata: { plan: 'pro' } }), { sessionId: 'cs_1', source: 'stripe_session_verify' });
  assert.equal(db.users[1].plan, 'pro');
  assert.equal(db.audit[0].source, 'stripe_session_verify');
});

test('wiring: webhook keeps express.raw + Stripe signature check; confirm path uses grantPlan; plan column in schema', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(src, /app\.post\('\/api\/payment\/webhook', express\.raw\(\{ type: 'application\/json' \}\)/);
  assert.match(src, /stripe\.webhooks\.constructEvent\(req\.body, sig/);
  assert.match(src, /_isStripeWebhook/);
  assert.match(src, /billingPlans\.handleEvent\(db, event/);
  assert.match(src, /billingPlans\.grantPlan\(db, req\.user\.id/);
  assert.match(src, /require\('\.\/assessments\/routes'\)\(app, \{ authMiddleware, db, rateLimit, getIP \}\)/);
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', 'schema.sql'), 'utf8');
  assert.match(schema, /ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT/);
});
