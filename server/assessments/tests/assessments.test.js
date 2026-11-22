'use strict';
// Run: node --test server/assessments/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const S = require('../scoring');
const engine = require('../engine');
const ws = require('../bank/workstyle.json');
const apt = require('../bank/aptitude.json');
const sjt = require('../bank/sjt.json');
const iv = require('../bank/interview.json');
const cfg = require('../bank/tracks.json');

// ───────── bank integrity ─────────
test('bank: 45 work-style items, 5 traits x 8 + 5 desirability, unique ids', () => {
  assert.equal(ws.items.length, 45);
  const c = {}; for (const i of ws.items) c[i.t] = (c[i.t] || 0) + 1;
  assert.deepEqual(c, { C: 8, S: 8, A: 8, X: 8, O: 8, D: 5 });
  for (const t of ['C', 'S', 'A', 'X', 'O']) {
    const l = ws.items.filter((i) => i.t === t);
    assert.equal(l.filter((i) => i.r).length, 4, 'balanced reverse keying for ' + t);
  }
  assert.equal(new Set(ws.items.map((i) => i.id)).size, 45);
});

test('bank: every item has Arabic and English, answer key in range, explanation present', () => {
  const all = [...apt.numerical, ...apt.verbal, ...apt.logical, ...apt.english];
  for (const it of all) {
    assert.ok(it.en && it.ar, it.id + ' bilingual');
    assert.ok(it.x && it.x.en && it.x.ar, it.id + ' explanation');
    const n = it.p ? 3 : it.opts.length;
    assert.ok(Number.isInteger(it.a) && it.a >= 0 && it.a < n, it.id + ' key range');
    if (it.p) assert.ok(apt.passages[it.p], it.id + ' passage');
  }
  for (const it of sjt.items) {
    assert.ok(it.en && it.ar && it.x.en && it.x.ar);
    assert.equal(it.opts.length, 4);
    const r = it.opts.map((o) => o.r);
    assert.ok(Math.max(...r) === 4 && Math.min(...r) === 1, it.id + ' rating spread');
    for (const o of it.opts) assert.ok(o.en && o.ar);
  }
  const ids = [...all.map((i) => i.id), ...sjt.items.map((i) => i.id), ...ws.items.map((i) => i.id)];
  assert.equal(new Set(ids).size, ids.length, 'ids unique across banks');
});

test('bank: numeric answer keys are mathematically right (independent recomputation)', () => {
  const k = (id) => { const it = apt.numerical.find((x) => x.id === id); return it.opts[it.a].replace(/[^\d.]/g, ''); };
  const eq = (a, b) => assert.equal(Math.round(Number(a) * 100) / 100, Math.round(b * 100) / 100);
  eq(k('num01'), 400000 * 1.15);
  eq(k('num02'), 120 * 0.75 * 1.15);
  eq(k('num03'), (120 + 150 + 135 + 195) / 4);
  eq(k('num04'), 4000 * 3 / 8);
  eq(k('num05'), ((80 - 68) / 80) * 100);
  eq(k('num06'), 180 / 2.5);
  eq(k('num07'), Math.round((20 / 46) * 100));
  eq(k('num08'), 13.5 * 500 - (12 * 500 + 600));
  eq(k('num09'), 60 / 4);
  eq(k('num10'), 5000 + 5000 * 0.04 * 3);
  eq(k('num11'), ((60 - 48) / 48) * 100);
  eq(k('num12'), 1500 / 3.75);
});

test('bank: sequences recomputed', () => {
  const key = (id) => { const it = apt.logical.find((x) => x.id === id); return it.opts[it.a]; };
  assert.equal(key('log01'), String(2 * 3 ** 4 === 162 ? 162 : 0));
  assert.equal(key('log02'), '40');
  assert.equal(key('log03'), '13');
  assert.equal(key('log04'), '4');
  assert.equal(key('log05'), 'U');
  assert.equal(key('log09'), '24');
  assert.equal(key('log12'), String(6 * 2 - 2));
});

test('bank: interview has all 21 families (incl. engineering) + general, 3 questions each, bilingual, track blueprints', () => {
  for (const f of engine.FAMILIES) assert.equal(iv.roles[f].q.length, 3, f);
  assert.equal(engine.FAMILIES.length, 21);
  for (const q of Object.values(iv.roles).flatMap((r) => r.q)) assert.ok(q.en && q.ar);
  for (const q of iv.competency) assert.ok(q.en && q.ar && iv.competencies[q.c]);
  for (const t of engine.TRACKS) assert.ok(iv.mockBlueprint[t].total >= 15 && iv.mockBlueprint[t].total <= 20);
});

test('bank: families match server/jobs/families.js ids', () => {
  let fam; try { fam = require('../../jobs/families.js').FAMILIES; } catch { return; }
  for (const id of Object.keys(fam)) if (id !== 'unknown') assert.ok(iv.roles[id], 'missing role bank for ' + id);
});

// ───────── scoring: work style ─────────
function wsAnswers(fn) { const a = {}; for (const i of ws.items) a[i.id] = fn(i); return a; }

test('workstyle: incomplete is rejected', () => {
  const r = S.scoreWorkStyle({ ws01: 3 });
  assert.equal(r.valid, false);
});

test('workstyle: reverse keying works (agree with positive, disagree with reversed -> high)', () => {
  const a = wsAnswers((i) => (i.t === 'D' ? 2 : i.r ? 2 : 4));
  const r = S.scoreWorkStyle(a, { family: 'finance' });
  assert.equal(r.valid, true);
  for (const t of ['C', 'S', 'A', 'X', 'O']) assert.equal(r.traits[t].score, 75, t);
  assert.equal(r.traits.C.fit, 'in_range');
});

test('workstyle: all-5 is flagged as straight-lining and impression management', () => {
  const r = S.scoreWorkStyle(wsAnswers(() => 5));
  assert.ok(r.flags.includes('straight_lining'));
  assert.ok(r.flags.includes('impression_management'));
  assert.equal(r.reliable, false);
});

test('workstyle: inconsistent keyed pairs are detected', () => {
  const a = wsAnswers((i) => (i.t === 'D' ? 2 : 5)); // agree with everything incl. reversed items
  const r = S.scoreWorkStyle(a);
  assert.ok(r.flags.includes('inconsistent'));
});

test('workstyle: role-group fit differs by family (low extraversion in sales vs data)', () => {
  const a = wsAnswers((i) => (i.t === 'D' ? 2 : i.t === 'X' ? (i.r ? 4 : 2) : (i.r ? 2 : 4)));
  const sales = S.scoreWorkStyle(a, { family: 'sales' });
  const data = S.scoreWorkStyle(a, { family: 'data' });
  assert.equal(sales.traits.X.fit, 'below');
  assert.equal(data.traits.X.fit, 'in_range');
  assert.equal(S.roleGroupForFamily('software'), 'analytical');
  assert.equal(S.roleGroupForFamily('nonexistent'), 'general');
});

// ───────── scoring: MCQ ─────────
test('mcq: scores, blanks, overtime', () => {
  const items = [{ id: 'a', a: 1 }, { id: 'b', a: 0 }, { id: 'c', a: 2 }, { id: 'd', a: 3 }];
  const r = S.scoreMCQ(items, { a: 1, b: 0, c: 1 }, { limitSec: 60, usedSec: 100 });
  assert.equal(r.correct, 2); assert.equal(r.wrong, 1); assert.equal(r.unanswered, 1);
  assert.equal(r.pct, 50); assert.equal(r.overtime, true); assert.equal(r.level, 'developing');
  assert.equal(S.scoreMCQ(items, { a: 1 }, { limitSec: 60, usedSec: 70 }).overtime, false, '15s grace');
});

test('mcq: perfect answers on the real numerical bank give 100', () => {
  const ans = {}; for (const i of apt.numerical) ans[i.id] = i.a;
  const r = S.scoreMCQ(apt.numerical, ans);
  assert.equal(r.pct, 100); assert.equal(r.level, 'strong');
});

// ───────── scoring: SJT ─────────
test('sjt: best/worst choice scoring', () => {
  const it = sjt.items[0];
  const best = it.opts.findIndex((o) => o.r === 4), worst = it.opts.findIndex((o) => o.r === 1);
  const perfect = S.scoreSJT([it], { [it.id]: { most: best, least: worst } });
  assert.equal(perfect.pct, 100);
  const reversed = S.scoreSJT([it], { [it.id]: { most: worst, least: best } });
  assert.equal(reversed.pct, 0);
  const same = S.scoreSJT([it], { [it.id]: { most: best, least: best } });
  assert.equal(same.pct, 0, 'same option for both is invalid');
  const mid = S.scoreSJT([it], { [it.id]: { most: best, least: it.opts.findIndex((o) => o.r === 3) } });
  assert.ok(mid.pct > 50 && mid.pct < 100);
});

// ───────── scoring: interview ─────────
const STRONG_EN = 'Last year at university I was responsible for a group project with four people and a two week deadline. I noticed two members were behind, so I called each of them, asked what was blocking them, and split the work into smaller tasks. I also wrote a shared checklist and checked progress every day. As a result we delivered two days early and the project scored 92%, and I learned to raise problems early.';
const STRONG_AR = 'السنة الماضية في الجامعة كنت مسؤولاً عن مشروع جماعي مع أربعة أشخاص وموعد تسليم بعد أسبوعين. لاحظت أن اثنين من الزملاء متأخران فتواصلت مع كل منهما وسألته عن العائق وقسمت العمل إلى مهام أصغر. كتبت أيضاً قائمة متابعة مشتركة وراجعت التقدم كل يوم. نتيجة لذلك سلمنا قبل الموعد بيومين وحصل المشروع على 92% وتعلمت أن أطرح المشاكل مبكراً.';

test('interview: strong STAR answer scores high in both languages', () => {
  const en = S.scoreInterviewAnswer(STRONG_EN, { lang: 'en', kind: 'behavioural' });
  const ar = S.scoreInterviewAnswer(STRONG_AR, { lang: 'ar', kind: 'behavioural' });
  assert.ok(en.score >= 75, 'en ' + en.score);
  assert.ok(ar.score >= 75, 'ar ' + ar.score);
  assert.ok(en.star.S && en.star.A && en.star.R);
});

test('interview: weak answers score lower than strong ones and give tips', () => {
  const weak = S.scoreInterviewAnswer('We worked together and it was fine, I guess. Maybe like we did okay and basically it worked out, you know, sort of well and the team was good and everything was fine in the end really.', { lang: 'en', kind: 'behavioural' });
  const strong = S.scoreInterviewAnswer(STRONG_EN, { lang: 'en', kind: 'behavioural' });
  assert.ok(weak.score < strong.score - 20);
  assert.ok(weak.tips.length >= 2);
});

test('interview: empty and too-short answers', () => {
  assert.equal(S.scoreInterviewAnswer('', { lang: 'en' }).score, 0);
  const s = S.scoreInterviewAnswer('I am good.', { lang: 'en' });
  assert.ok(s.score <= 10 && s.tooShort);
});

test('interview: Arabic text in English mode is flagged and capped', () => {
  const r = S.scoreInterviewAnswer(STRONG_AR, { lang: 'en', kind: 'behavioural' });
  assert.equal(r.wrongLanguage, true);
  assert.ok(r.score <= 55);
});

test('interview: role answers use field keywords', () => {
  const kw = iv.roles.sales.kw;
  const a = 'I would research the prospect first, then reach out with a short message about a problem they have. If they raise an objection about price I would ask questions, show the value with a number from a similar customer, and offer a pilot. My target is to move the lead to a meeting in two calls and then negotiate the closing terms with the pipeline in mind.';
  const withKw = S.scoreInterviewAnswer(a, { lang: 'en', kind: 'role', keywords: kw });
  const noKw = S.scoreInterviewAnswer(a, { lang: 'en', kind: 'role', keywords: ['sql', 'dashboard', 'metric', 'clean'] });
  assert.ok(withKw.score > noKw.score);
});

test('interview: pace feedback when spoken seconds are supplied', () => {
  const r = S.scoreInterviewAnswer({ text: STRONG_EN, seconds: 20 }, { lang: 'en', kind: 'behavioural' });
  assert.ok(r.paceWpm > 190);
  assert.ok(r.tips.some((t) => /fast/i.test(t.en)));
});

// ───────── readiness ─────────
test('readiness: empty -> 0 and provisional', () => {
  const r = S.readiness([]);
  assert.equal(r.score, 0); assert.equal(r.provisional, true); assert.equal(r.band, 'early');
});

test('readiness: weighted, coverage and the mock-final gate on "ready"', () => {
  const d = (t, pct, day = 1) => ({ test: t, pct, createdAt: `2026-11-${10 + day}T10:00:00Z` });
  const all = [d('numerical', 90), d('verbal', 90), d('logical', 90), d('workstyle45', 90), d('sjt_set_1', 90), d('interview_competency', 90), d('english', 90)];
  const noMock = S.readiness(all);
  assert.equal(noMock.coverage, 100);
  assert.equal(noMock.band, 'nearly', 'cannot be ready without a mock final');
  const withMock = S.readiness([...all, d('mock_final', 90, 2)]);
  assert.equal(withMock.band, 'ready');
  assert.equal(withMock.score, 90);
});

test('readiness: diagnostic does not count, best of recent 3 is used', () => {
  const r = S.readiness([
    { test: 'diagnostic', pct: 100, createdAt: '2026-11-01' },
    { test: 'numerical', pct: 40, createdAt: '2026-11-01' },
    { test: 'numerical', pct: 70, createdAt: '2026-11-02' },
    { test: 'numerical', pct: 60, createdAt: '2026-11-03' },
  ]);
  assert.equal(r.components.aptitude, 70);
  assert.equal(r.coverage, 25);
});

// ───────── engine ─────────
test('engine: sessions build for every test and never leak keys', () => {
  for (const t of Object.keys(cfg.tests)) {
    for (const track of engine.TRACKS) {
      const s = engine.buildSession({ test: t, track, lang: 'ar', family: 'sales', sessionId: 'x' + t });
      assert.ok(!s.error, t);
      assert.ok(s.itemIds.length > 0);
      const pub = s.itemIds.map(engine.publicItem);
      assert.ok(pub.every(Boolean), t + ' public items exist');
      const json = JSON.stringify(pub);
      assert.ok(!/"a":|"x":|"r":|"explain/.test(json), t + ' leaks key: ' + json.slice(0, 80));
    }
  }
});

test('engine: item counts match the promise', () => {
  const n = (t, track = 'fresh_grad') => engine.buildSession({ test: t, track, family: 'sales', sessionId: 's' }).itemIds.length;
  assert.equal(n('workstyle45'), 45);
  assert.equal(n('numerical'), 12); assert.equal(n('verbal'), 10); assert.equal(n('logical'), 12); assert.equal(n('english'), 12);
  assert.equal(n('sjt_set_1'), 5); assert.equal(n('sjt_set_2'), 5);
  assert.equal(n('interview_quick'), 6); assert.equal(n('interview_competency'), 10);
  assert.equal(n('mock_final', 'fresh_grad'), 18); assert.equal(n('mock_final', 'experienced'), 20); assert.equal(n('mock_final', 'simple_job'), 15);
  assert.equal(n('diagnostic'), 22);
});

test('engine: mock final has no duplicates, uses the family questions and is deterministic per session', () => {
  const a = engine.buildSession({ test: 'mock_final', track: 'fresh_grad', family: 'finance', sessionId: 'same' });
  const b = engine.buildSession({ test: 'mock_final', track: 'fresh_grad', family: 'finance', sessionId: 'same' });
  const c = engine.buildSession({ test: 'mock_final', track: 'fresh_grad', family: 'finance', sessionId: 'other' });
  assert.deepEqual(a.itemIds, b.itemIds);
  assert.equal(new Set(a.itemIds).size, a.itemIds.length);
  for (const q of iv.roles.finance.q) assert.ok(a.itemIds.includes(q.id));
  assert.notDeepEqual(a.itemIds, c.itemIds);
});

test('engine: unknown family falls back to general_entry, unknown test errors', () => {
  const s = engine.buildSession({ test: 'interview_role', track: 'fresh_grad', family: 'astronaut', sessionId: 'q' });
  assert.equal(s.family, 'general_entry');
  assert.equal(engine.buildSession({ test: 'nope' }).error, 'unknown_test');
});

test('engine: grade + report for each kind', () => {
  // mcq
  let s = engine.buildSession({ test: 'numerical', track: 'fresh_grad', sessionId: 'n1' });
  const ans = {}; for (const id of s.itemIds) ans[id] = engine.LOOKUP.get(id).a;
  let rep = engine.buildReport(s, engine.grade(s, ans, { usedSec: 300 }));
  assert.equal(rep.result.pct, 100);
  assert.ok(Object.keys(rep.explanations).length === 12);
  // sjt
  s = engine.buildSession({ test: 'sjt_set_1', track: 'fresh_grad', sessionId: 'j1' });
  const sa = {}; for (const id of s.itemIds) { const it = engine.LOOKUP.get(id); sa[id] = { most: it.opts.findIndex((o) => o.r === 4), least: it.opts.findIndex((o) => o.r === 1) }; }
  assert.equal(engine.grade(s, sa).pct, 100);
  // likert
  s = engine.buildSession({ test: 'workstyle45', track: 'fresh_grad', family: 'data', sessionId: 'w1' });
  const wa = {}; for (const id of s.itemIds) { const i = engine.LOOKUP.get(id); wa[id] = i.t === 'D' ? 2 : i.r ? 2 : 4; }
  const lr = engine.grade(s, wa); assert.equal(lr.valid, true);
  assert.ok(engine.buildReport(s, lr).nextSteps.length >= 0);
  // interview
  s = engine.buildSession({ test: 'mock_final', track: 'fresh_grad', family: 'sales', lang: 'en', sessionId: 'm1' });
  const ia = {}; for (const id of s.itemIds) ia[id] = STRONG_EN;
  const ir = engine.grade(s, ia);
  assert.equal(ir.items.length, 18);
  assert.ok(ir.pct > 40);
  const blank = engine.grade(s, {});
  assert.equal(blank.pct, 0);
  // diagnostic
  s = engine.buildSession({ test: 'diagnostic', track: 'fresh_grad', sessionId: 'd1' });
  const da = {}; for (const id of s.itemIds) { const it = engine.LOOKUP.get(id); da[id] = it.type === 'likert' ? 3 : it.type === 'sjt' ? { most: 0, least: 1 } : 0; }
  const dr = engine.grade(s, da);
  assert.ok(dr.recommendedPlan.length >= 3 && dr.weakest.length === 2);
});

// ───────── HTTP: full flow through Express ─────────
test('routes: full flow, tier gating, no key leakage, resume, ownership', async () => {
  const express = require('express');
  const mount = require('../routes');
  const app = express();
  app.use(express.json());
  const auth = (req, res, next) => {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    if (!t) return res.status(401).json({ error: 'Login required' });
    req.user = { id: t }; next();
  };
  const tiers = { free1: 'free', st1: 'starter', pro1: 'pro', free2: 'free' };
  mount(app, { authMiddleware: auth, getTier: async (req) => tiers[req.user.id] || 'free' });
  const server = await new Promise((r) => { const s = http.createServer(app).listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port + '/api/assess';
  const call = async (method, path, token, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  try {
    assert.equal((await call('POST', '/start', null, { test: 'diagnostic' })).status, 401);

    const cat = await call('GET', '/catalog', 'free1');
    assert.equal(cat.body.tier, 'free');
    assert.equal(cat.body.tests.find((t) => t.id === 'mock_final').unlocked, false);
    assert.equal(cat.body.tests.find((t) => t.id === 'diagnostic').unlocked, true);
    assert.equal((await call('GET', '/catalog', null)).body.tier, 'free');

    // gating
    assert.equal((await call('POST', '/start', 'free1', { test: 'numerical' })).status, 402);
    assert.equal((await call('POST', '/start', 'free1', { test: 'mock_final' })).status, 402);
    assert.equal((await call('POST', '/start', 'st1', { test: 'mock_final' })).status, 402);
    const eng = await call('POST', '/start', 'st1', { test: 'interview_competency', lang: 'en' });
    assert.equal(eng.status, 402); assert.equal(eng.body.feature, 'english_interview');
    assert.equal((await call('POST', '/start', 'free1', { test: 'sjt_set_1', timed: true })).status, 402);
    assert.equal((await call('POST', '/start', 'free1', { test: 'bogus' })).status, 400);

    // free: diagnostic, answer partial, resume, submit
    const st = await call('POST', '/start', 'free1', { test: 'diagnostic', track: 'fresh_grad' });
    assert.equal(st.status, 200);
    assert.equal(st.body.items.length, 22);
    assert.ok(!/"a":|"x":|"r":/.test(JSON.stringify(st.body.items)), 'no keys in payload');
    const sid = st.body.sessionId;
    const first = st.body.items[0];
    assert.equal((await call('POST', `/session/${sid}/answer`, 'free1', { id: first.id, value: 4 })).status, 200);
    assert.equal((await call('POST', `/session/${sid}/answer`, 'free1', { id: first.id, value: 9 })).status, 400);
    assert.equal((await call('POST', `/session/${sid}/answer`, 'free1', { id: 'zzz', value: 1 })).status, 400);
    const again = await call('POST', '/start', 'free1', { test: 'diagnostic', track: 'fresh_grad' });
    assert.equal(again.body.resumed, true); assert.equal(again.body.sessionId, sid); assert.equal(again.body.answers[first.id], 4);
    assert.equal((await call('GET', `/session/${sid}`, 'free2')).status, 404, 'other user cannot read');
    assert.equal((await call('POST', `/session/${sid}/submit`, 'free2', {})).status, 404);

    const answers = {};
    for (const it of st.body.items) answers[it.id] = it.type === 'likert' ? 3 : it.type === 'sjt' ? { most: 0, least: 1 } : 0;
    const sub = await call('POST', `/session/${sid}/submit`, 'free1', { answers });
    assert.equal(sub.status, 200);
    assert.ok(sub.body.report.result.recommendedPlan.length);
    assert.equal(sub.body.readiness.provisional, true);
    assert.equal((await call('POST', `/session/${sid}/submit`, 'free1', {})).body.alreadySubmitted, true);
    assert.equal((await call('GET', `/session/${sid}/report`, 'free1')).status, 200);

    // free SJT
    const sj = await call('POST', '/start', 'free1', { test: 'sjt_set_1' });
    assert.equal(sj.status, 200); assert.equal(sj.body.items.length, 5);

    // starter: numerical 12 + explanations only in the report
    const nu = await call('POST', '/start', 'st1', { test: 'numerical', timed: true });
    assert.equal(nu.body.items.length, 12); assert.equal(nu.body.timeLimitSec, 18 * 60);
    const na = {}; for (const it of nu.body.items) na[it.id] = 0;
    const nr = await call('POST', `/session/${nu.body.sessionId}/submit`, 'st1', { answers: na });
    assert.equal(nr.status, 200);
    assert.equal(Object.keys(nr.body.report.explanations).length, 12);

    // pro: English mock final
    const mk = await call('POST', '/start', 'pro1', { test: 'mock_final', lang: 'en', track: 'experienced', family: 'finance' });
    assert.equal(mk.status, 200); assert.equal(mk.body.items.length, 20);
    const ma = {}; for (const it of mk.body.items) ma[it.id] = { text: STRONG_EN, seconds: 70 };
    const mr = await call('POST', `/session/${mk.body.sessionId}/submit`, 'pro1', { answers: ma });
    assert.equal(mr.status, 200); assert.ok(mr.body.report.result.pct > 40);

    // progress
    const pg = await call('GET', '/progress?track=fresh_grad', 'free1');
    assert.equal(pg.status, 200);
    assert.equal(pg.body.plan.find((p) => p.test === 'diagnostic').done, true);
    assert.equal(pg.body.nextStep, 'workstyle45');
    assert.equal(pg.body.history.length, 1);

    // attempt limit for free: sjt_set_1 allowed 2 per 30 days
    const sj2 = await call('POST', `/session/${sj.body.sessionId}/submit`, 'free1', { answers: {} });
    assert.equal(sj2.status, 200);
    assert.equal((await call('POST', '/start', 'free1', { test: 'sjt_set_1' })).status, 200);
    const sj3 = await call('POST', '/start', 'free1', { test: 'sjt_set_1' });
    assert.equal(sj3.status, 200, 'resumes the open session');
    assert.equal(sj3.body.resumed, true);
  } finally { server.close(); }
});
