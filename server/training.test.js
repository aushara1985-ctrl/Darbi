// Training is real and visible: interview answers are read by the AI, the
// fallback is named «التقييم المختصر» (never silent), every path ends in a
// result with next steps and a readiness score built from real attempts, and
// every bank question carries an explanation. The AI client is a stub.
// Run: node --test server/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const ai = require('./assessments/aiInterview');
const engine = require('./assessments/engine');
const S = require('./assessments/scoring');
const apt = require('./assessments/bank/aptitude.json');
const sjt = require('./assessments/bank/sjt.json');
const cfg = require('./assessments/bank/tracks.json');

const LONG = 'في تدريبي التعاوني كان عندنا تأخير في إقفال الشهر. كانت مهمتي تسوية الحسابات البنكية. راجعت الكشوف يومياً وبنيت جدول متابعة ورتبت الفروقات حسب الأهمية. النتيجة أننا أقفلنا قبل الموعد بيومين.';

function gradedInterview(lang) {
  const session = engine.buildSession({ test: 'interview_quick', track: 'fresh_grad', lang: lang || 'ar', family: 'accounting', sessionId: 'seed-1' });
  const answers = {};
  session.itemIds.forEach((id, i) => { if (i < 4) answers[id] = LONG; });   // 4 answered, 2 left blank
  const result = engine.grade(session, answers);
  return { session, answers, result };
}

test('interview: AI path reads every answered question and its scores replace the structural ones', async () => {
  const { session, answers, result } = gradedInterview();
  const structural = result.items.map((r) => r.res.score);
  const seen = [];
  const chat = async (messages) => {
    const user = messages[1].content;
    const ids = [...user.matchAll(/^ID: (.+)$/gm)].map((m) => m[1]);
    seen.push(...ids);
    assert.ok(/Never invent numbers/.test(messages[0].content));
    assert.ok(user.includes('تسوية الحسابات البنكية'), 'the real answer text is sent');
    return { results: ids.map((id) => ({ id, score: 72, verdict: 'إجابة مرتبطة بالسؤال', strengths: ['مثال واقعي'], improve: ['اذكر الرقم'], betterAnswer: 'نسخة أقوى [اذكر الرقم الفعلي]' })) };
  };
  await ai.applyToResult(session, answers, result, { chat, role: 'accounting' });
  assert.strictEqual(result.evaluator, 'ai');
  assert.strictEqual(result.evaluatorLabel.ar, 'تقييم دربي بالذكاء الاصطناعي');
  assert.strictEqual(seen.length, 4, 'only answered questions are sent');
  const answered = result.items.filter((r) => r.res.ai);
  assert.strictEqual(answered.length, 4);
  for (const r of answered) { assert.strictEqual(r.res.score, 72); assert.ok(typeof r.res.structureScore === 'number'); assert.ok(r.res.ai.betterAnswer); }
  const blank = result.items.filter((r) => !r.res.ai);
  assert.strictEqual(blank.length, 2);
  for (const r of blank) assert.ok(r.res.score <= 10, 'unanswered questions keep a near-zero score');
  assert.strictEqual(result.pct, result.summary.avg);
  assert.strictEqual(result.pct, Math.round((72 * 4 + blank.reduce((s, r) => s + r.res.score, 0)) / 6));
  assert.notDeepStrictEqual(result.items.map((r) => r.res.score), structural);
});

test('interview: no AI key -> «التقييم المختصر» with a note that says what it checks', async () => {
  const { session, answers, result } = gradedInterview();
  const before = result.pct;
  await ai.applyToResult(session, answers, result, { chat: null });
  assert.strictEqual(result.evaluator, 'short');
  assert.strictEqual(result.evaluatorLabel.ar, 'التقييم المختصر');
  assert.ok(/بنية الإجابة فقط/.test(result.evaluatorNote.ar));
  assert.strictEqual(result.evaluatorReason, 'not_configured');
  assert.strictEqual(result.pct, before, 'the structural score is kept as is');
  assert.ok(result.items.every((r) => !r.res.ai));
});

test('interview: an AI failure or a partial AI answer is never passed off as an AI evaluation', async () => {
  let errs = 0;
  const a = gradedInterview();
  await ai.applyToResult(a.session, a.answers, a.result, { chat: async () => { throw new Error('boom'); }, onError: () => errs++ });
  assert.strictEqual(a.result.evaluator, 'short');
  assert.strictEqual(a.result.evaluatorReason, 'failed');
  assert.strictEqual(errs, 1);

  const b = gradedInterview();
  const chat = async (messages) => {
    const ids = [...messages[1].content.matchAll(/^ID: (.+)$/gm)].map((m) => m[1]);
    return { results: [{ id: ids[0], score: 90 }] };   // only one of four
  };
  await ai.applyToResult(b.session, b.answers, b.result, { chat });
  assert.strictEqual(b.result.evaluator, 'short');
  assert.strictEqual(b.result.evaluatorReason, 'incomplete');
  assert.ok(b.result.items.every((r) => !r.res.ai), 'no mixed AI/structural scores');

  const c = gradedInterview();
  await ai.applyToResult(c.session, c.answers, c.result, { chat: () => new Promise(() => {}), timeoutMs: 30 });
  assert.strictEqual(c.result.evaluator, 'short', 'a hanging AI call times out into the labelled short evaluation');
});

test('interview: AI scores are clamped and unknown ids ignored', async () => {
  const qs = [{ id: 'q1', kind: 'behavioural', question: 'Q', answer: LONG }];
  const out = await ai.evaluateAnswers(qs, { lang: 'ar' }, { chat: async () => ({ results: [{ id: 'q1', score: 250 }, { id: 'zzz', score: 50 }, { id: 'q1b', score: 'x' }] }) });
  assert.deepStrictEqual(Object.keys(out), ['q1']);
  assert.strictEqual(out.q1.score, 100);
});

test('interview: a "stronger version" with a number the person never wrote is dropped', async () => {
  assert.strictEqual(ai.inventsNumber('خفضت الوقت 40%', 'خفضت الوقت'), true);
  assert.strictEqual(ai.inventsNumber('أقفلنا قبل الموعد بيومين مع 12 حساب', 'راجعت 12 حساب'), false);
  assert.strictEqual(ai.inventsNumber('خفضت الوقت بنسبة [اذكر النسبة 20%]', 'خفضت الوقت'), false, 'bracketed prompts are placeholders');
  const qs = [{ id: 'q1', kind: 'behavioural', question: 'Q', answer: LONG }];
  const out = await ai.evaluateAnswers(qs, { lang: 'ar' }, { chat: async () => ({ results: [{ id: 'q1', score: 60, betterAnswer: 'رفعت الدقة 35% خلال شهرين' }] }) });
  assert.strictEqual(out.q1.betterAnswer, '');
  assert.strictEqual(out.q1.score, 60, 'the evaluation itself is kept');
});

test('every training path ends in a result with a summary, next steps and an honesty note', () => {
  for (const test of Object.keys(cfg.tests)) {
    const session = engine.buildSession({ test, track: 'fresh_grad', lang: 'ar', family: 'accounting', sessionId: 'p-' + test });
    assert.ok(!session.error, test);
    const result = engine.grade(session, {});          // even an empty attempt must produce a report
    const report = engine.buildReport(session, result);
    assert.ok(report.title.ar, test + ' title');
    assert.ok(report.honestyNote && report.honestyNote.ar, test + ' honesty note');
    assert.ok(Array.isArray(report.nextSteps), test + ' next steps');
    if (result.kind !== 'likert') assert.strictEqual(typeof result.pct, 'number', test + ' has a score');
  }
  for (const [track, def] of Object.entries(cfg.tracks)) {
    assert.ok(def.path.length >= 3 && def.path.includes('mock_final'), track + ' ends in the mock final interview');
    for (const t of def.path) assert.ok(cfg.tests[t], track + ' -> ' + t);
  }
});

test('readiness comes only from real submitted attempts', () => {
  const none = S.readiness([]);
  assert.strictEqual(none.score, 0);
  assert.strictEqual(none.coverage, 0);
  assert.ok(none.provisional);
  const some = S.readiness([
    { test: 'sjt_set_1', pct: 80, createdAt: '2026-11-20T10:00:00Z' },
    { test: 'interview_quick', pct: 60, createdAt: '2026-11-21T10:00:00Z' },
  ]);
  assert.ok(some.score >= 60 && some.score <= 80);
  assert.deepStrictEqual(Object.keys(some.components).sort(), ['interview', 'sjt']);
  assert.ok(some.missing.includes('aptitude'));
  assert.notStrictEqual(some.band, 'ready', 'no "ready" without coverage and a mock final');
  assert.ok(some.note.ar);
});

test('explanations: every aptitude and situational question explains the answer in Arabic and English', () => {
  const all = [...apt.numerical, ...apt.verbal, ...apt.logical, ...apt.english, ...sjt.items];
  assert.ok(all.length >= 56);
  for (const it of all) {
    assert.ok(it.x && it.x.ar && it.x.ar.length >= 12, it.id + ' needs an Arabic explanation');
    assert.ok(it.x.en && it.x.en.length >= 12, it.id + ' needs an English explanation');
  }
  // and the report carries them, keyed by question, next to which answers were wrong
  const session = engine.buildSession({ test: 'numerical', track: 'fresh_grad', lang: 'ar', sessionId: 'x1' });
  const wrongAll = {}; for (const id of session.itemIds) wrongAll[id] = (engine.LOOKUP.get(id).a + 1) % 5;
  const result = engine.grade(session, wrongAll);
  const report = engine.buildReport(session, result);
  assert.strictEqual(result.wrong, session.itemIds.length);
  for (const d of result.detail) { assert.strictEqual(d.ok, false); assert.ok(report.explanations[d.id].ar, d.id); }
});

test('HTTP: submitting an interview returns the evaluator, per-answer AI feedback, next steps and readiness', async () => {
  const express = require('express');
  const mount = require('./assessments/routes');
  const run = async (interviewChat) => {
    const app = express(); app.use(express.json());
    const auth = (req, res, next) => { const t = (req.headers.authorization || '').replace('Bearer ', ''); if (!t) return res.status(401).json({ error: 'Login required' }); req.user = { id: t }; next(); };
    mount(app, { authMiddleware: auth, getTier: async () => 'free', interviewChat });
    const server = await new Promise((r) => { const s = http.createServer(app).listen(0, () => r(s)); });
    const base = 'http://127.0.0.1:' + server.address().port + '/api/assess';
    const call = async (method, path, body) => {
      const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer TEST-user' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() };
    };
    try {
      const st = await call('POST', '/start', { test: 'interview_quick', track: 'fresh_grad', family: 'accounting' });
      assert.strictEqual(st.status, 200);
      const answers = {}; st.body.items.forEach((it) => { answers[it.id] = LONG; });
      const sub = await call('POST', '/session/' + st.body.sessionId + '/submit', { answers });
      assert.strictEqual(sub.status, 200);
      return sub.body;
    } finally { await new Promise((r) => server.close(r)); }
  };

  const withAi = await run(async (messages) => {
    const ids = [...messages[1].content.matchAll(/^ID: (.+)$/gm)].map((m) => m[1]);
    return { results: ids.map((id) => ({ id, score: 81, verdict: 'قوية', strengths: ['نتيجة واضحة'], improve: ['اختصر المقدمة'], betterAnswer: 'نسخة أقوى' })) };
  });
  assert.strictEqual(withAi.report.evaluator, 'ai');
  assert.strictEqual(withAi.report.result.pct, 81);
  assert.ok(withAi.report.result.items.every((r) => r.res.ai && r.res.ai.improve.length));
  assert.ok(/الذكاء الاصطناعي/.test(withAi.report.honestyNote.ar));
  assert.ok(withAi.report.nextSteps.length >= 1);
  assert.strictEqual(withAi.readiness.components.interview, 81, 'readiness is built from this real attempt');

  const noAi = await run(null);
  assert.strictEqual(noAi.report.evaluator, 'short');
  assert.strictEqual(noAi.report.result.evaluatorLabel.ar, 'التقييم المختصر');
  assert.ok(/التقييم المختصر/.test(noAi.report.honestyNote.ar));
  assert.ok(noAi.report.result.items.every((r) => !r.res.ai));
});
