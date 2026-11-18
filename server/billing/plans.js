'use strict';
// Plan bookkeeping for Stripe events. Pure functions plus DB helpers that take `db` (pg Pool) as an argument,
// so they can be unit-tested with a fake. The raw-body webhook itself stays in server/index.js.

const VALID = ['starter', 'pro', 'lifetime'];
const AMOUNT_TO_PLAN = { 900: 'starter', 1900: 'pro', 19900: 'lifetime' };

function priceMap(env = process.env) {
  const m = {};
  if (env.STRIPE_PRICE_STARTER_MONTHLY) m[env.STRIPE_PRICE_STARTER_MONTHLY] = 'starter';
  if (env.STRIPE_PRICE_PRO_MONTHLY) m[env.STRIPE_PRICE_PRO_MONTHLY] = 'pro';
  if (env.STRIPE_PRICE_FOUNDER_LIFETIME) m[env.STRIPE_PRICE_FOUNDER_LIFETIME] = 'lifetime';
  return m;
}

function priceIdOf(obj) {
  if (!obj) return null;
  const li = obj.line_items && obj.line_items.data && obj.line_items.data[0];
  if (li && li.price && li.price.id) return li.price.id;
  const it = obj.items && obj.items.data && obj.items.data[0];
  if (it && it.price && it.price.id) return it.price.id;
  return null;
}

// Checkout session, subscription or anything with metadata. Order: metadata.plan, price id, amount.
function resolvePlan(obj, env = process.env) {
  const meta = obj && obj.metadata && obj.metadata.plan;
  if (VALID.includes(meta)) return meta;
  const pid = priceIdOf(obj);
  const byPrice = pid && priceMap(env)[pid];
  if (byPrice) return byPrice;
  if (obj && typeof obj.amount_total === 'number' && AMOUNT_TO_PLAN[obj.amount_total]) return AMOUNT_TO_PLAN[obj.amount_total];
  return null;
}

// Grants paid access and stores the plan. A lifetime buyer is never moved to a monthly plan.
async function grantPlan(db, userId, plan, { sessionId = null, source = 'stripe_webhook' } = {}) {
  const p = VALID.includes(plan) ? plan : null;
  await db.query(
    `UPDATE users SET access_status = 'paid', paid_at = COALESCE(paid_at, NOW()),
       plan = CASE WHEN plan = 'lifetime' THEN plan ELSE COALESCE($2, plan) END
     WHERE id = $1`, [userId, p]);
  await db.query(
    `INSERT INTO access_audit (user_id, source, status_to, stripe_session_id, note)
     VALUES ($1, $2, 'paid', $3, $4)`, [userId, source, sessionId, 'plan:' + (p || 'unknown')]).catch(() => {});
}

async function isLifetime(db, userId) {
  const u = await db.query(`SELECT plan FROM users WHERE id = $1`, [userId]).catch(() => ({ rows: [] }));
  if (u.rows[0] && u.rows[0].plan === 'lifetime') return true;
  const a = await db.query(`SELECT 1 FROM access_audit WHERE user_id = $1 AND note = 'plan:lifetime' LIMIT 1`, [userId]).catch(() => ({ rows: [] }));
  return a.rows.length > 0;
}

// Removes paid access unless the user owns the lifetime plan. Returns true when access was revoked.
async function revokePlan(db, userId, reason) {
  if (await isLifetime(db, userId)) return false;
  await db.query(`UPDATE users SET access_status = 'free', plan = NULL WHERE id = $1 AND access_status = 'paid'`, [userId]);
  await db.query(
    `INSERT INTO access_audit (user_id, source, status_to, stripe_session_id, note)
     VALUES ($1, 'stripe_webhook', 'free', NULL, $2)`, [userId, reason]).catch(() => {});
  return true;
}

// Active subscription changed (for example Starter -> Pro in the customer portal): keep the plan in step.
async function syncActiveSubscriptionPlan(db, userId, sub, env = process.env) {
  // The price is the truth after a portal change; metadata.plan may be stale.
  const pid = priceIdOf(sub);
  const plan = (pid && priceMap(env)[pid]) || resolvePlan(sub, env);
  if (!plan || plan === 'lifetime') return false;
  await db.query(`UPDATE users SET plan = $2 WHERE id = $1 AND access_status = 'paid' AND COALESCE(plan, '') <> 'lifetime'`, [userId, plan]);
  return true;
}

// Applies one verified Stripe event. `stripe` is only used to look up a customer's email for old subscriptions.
async function handleEvent(db, event, { stripe, env = process.env, log = console } = {}) {
  const obj = event.data && event.data.object;
  if (event.type === 'checkout.session.completed') {
    const userId = obj.metadata && obj.metadata.userId;
    if (userId) {
      await grantPlan(db, userId, resolvePlan(obj, env), { sessionId: obj.id, source: 'stripe_webhook' })
        .catch((e) => log.error('[webhook] update user paid failed:', e.message));
    }
    return;
  }
  if (event.type !== 'customer.subscription.deleted' && event.type !== 'customer.subscription.updated') return;
  const sub = obj;
  if (event.type === 'customer.subscription.updated' && ['active', 'trialing'].includes(sub.status) && sub.metadata && sub.metadata.userId) {
    await syncActiveSubscriptionPlan(db, sub.metadata.userId, sub, env).catch(() => {});
  }
  const ended = ['canceled', 'unpaid', 'incomplete_expired'];
  if (!(event.type === 'customer.subscription.deleted' || ended.includes(sub.status))) return;
  try {
    let userId = (sub.metadata && sub.metadata.userId) || null;
    if (!userId && sub.customer && stripe) {
      const cust = await stripe.customers.retrieve(sub.customer);
      if (cust && cust.email) {
        const u = await db.query('SELECT id FROM users WHERE lower(email) = lower($1)', [cust.email]);
        userId = u.rows[0] && u.rows[0].id;
      }
    }
    // A Founder lifetime buyer is never downgraded by a subscription event (checked inside revokePlan).
    if (userId) await revokePlan(db, userId, 'subscription_' + (event.type === 'customer.subscription.deleted' ? 'deleted' : sub.status));
  } catch (e) { log.error('[webhook] subscription revoke failed:', e.message); }
}

module.exports = { handleEvent, resolvePlan, grantPlan, revokePlan, isLifetime, syncActiveSubscriptionPlan, priceMap, VALID };
