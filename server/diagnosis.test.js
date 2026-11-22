// Diagnosis: real AI reading for any field, neutral labelled fallback, no fixed
// interview-readiness number. Run: node --test server/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const dx = require('./diagnosis');

const CV_ACCOUNTANT = [
  'Ahmed Test', 'ahmed@example.com 0550000000',
  'Accountant at Test Trading Co, 2021 - 2024',
  'Prepared monthly closing for 3 entities and reduced closing time by 20%',
  'Managed accounts payable for 150 vendors, organized audit files',
  'Bachelor of Accounting, 2020',
].join('\n');
const CV_CS = [
  'Sara Test', 'sara@example.com 0551111111',
  'Customer success manager, churn and retention, health score, playbook, renewal, onboarding',
].join('\n');

test('prompt is family-neutral and never asks for a guessed interview score', () => {
  const p = dx.systemPrompt();
  assert.ok(/ANY field/.test(p));
  assert.ok(!/customer success|churn|retention|\bCS\b/i.test(p), 'no customer-success anchoring in the prompt');
  assert.ok(!/interviewReadiness/.test(p));
});

test('AI path: scores come from the model, clamped; interview readiness is null', async () => {
  const chat = async (messages) => {
    assert.ok(messages[1].content.includes('TARGET ROLE: Senior Accountant'));
    assert.ok(messages[1].content.includes('Prepared monthly closing'));
    return { cvStrengthScore: 78.4, jobFitScore: 140, seniority: 'mid', strengths: ['أرقام واضحة'], gaps: ['a', 'b', 'c', 'd', 'e'],
      whyNotGetting: 'x', topFix: 'y', missingKeywords: ['IFRS'], nearestRoles: ['Accountant'], interviewReadinessScore: 25 };
  };
  const r = await dx.analyzeCv({ targetRole: 'Senior Accountant', cvText: CV_ACCOUNTANT }, { chat });
  assert.strictEqual(r.source, 'ai');
  assert.strictEqual(r.result.cvStrengthScore, 78);
  assert.strictEqual(r.result.jobFitScore, 100);
  assert.strictEqual(r.result.interviewReadinessScore, null, 'never the fixed 25');
  assert.strictEqual(r.result.gaps.length, 4);
  assert.strictEqual(r.result.seniority, 'mid');
});

test('fallback: labelled estimate, and customer-success words give no bonus', async () => {
  const noAi = await dx.analyzeCv({ targetRole: 'Accountant', cvText: CV_ACCOUNTANT }, { chat: null });
  assert.strictEqual(noAi.source, 'heuristic');
  assert.strictEqual(noAi.fallback, true);
  assert.ok(/بدون ذكاء اصطناعي/.test(noAi.label));
  assert.strictEqual(noAi.result.interviewReadinessScore, null);
  const acc = dx.heuristicAnalysis(dx.cleanInput({ targetRole: 'Accountant', cvText: CV_ACCOUNTANT }));
  const cs = dx.heuristicAnalysis(dx.cleanInput({ targetRole: 'Customer Success Manager', cvText: CV_CS }));
  assert.ok(acc.cvStrengthScore > cs.cvStrengthScore, 'an evidenced accounting CV beats a keyword-only CS line');
  // The same evidence scores the same strength whatever the field words are.
  const a = dx.heuristicAnalysis(dx.cleanInput({ targetRole: 'Nurse', cvText: 'Managed 12 patients daily, 2021 - 2023, reduced waiting 15%\nBachelor of Nursing 2020\nline five here\nline six here' }));
  const b = dx.heuristicAnalysis(dx.cleanInput({ targetRole: 'Customer Success', cvText: 'Managed 12 accounts daily, 2021 - 2023, reduced churn 15%\nBachelor of Business 2020\nline five here\nline six here' }));
  assert.strictEqual(a.cvStrengthScore, b.cvStrengthScore);
});

test('AI error or malformed answer falls back to the labelled estimate', async () => {
  let errs = 0;
  const bad = await dx.analyzeCv({ targetRole: 'Accountant', cvText: CV_ACCOUNTANT }, { chat: async () => ({ nope: true }), onError: () => errs++ });
  assert.strictEqual(bad.source, 'heuristic');
  const boom = await dx.analyzeCv({ targetRole: 'Accountant', cvText: CV_ACCOUNTANT }, { chat: async () => { throw new Error('x'); }, onError: () => errs++ });
  assert.strictEqual(boom.source, 'heuristic');
  assert.strictEqual(errs, 2);
});

test('missing input is refused, not scored', async () => {
  const r = await dx.analyzeCv({ targetRole: '', cvText: CV_ACCOUNTANT }, { chat: null });
  assert.strictEqual(r.success, false);
  const r2 = await dx.analyzeCv({ targetRole: 'Accountant', cvText: 'short' }, { chat: null });
  assert.strictEqual(r2.success, false);
});

test('Arabic CVs and Arabic digits are read by the estimate', () => {
  const r = dx.heuristicAnalysis(dx.cleanInput({ targetRole: 'محاسب', cvText: 'محاسب في شركة الاختبار ٢٠٢١ - ٢٠٢٤\nإعداد الإقفال الشهري وتحليل الحسابات\nرفع دقة التقارير ٢٠٪ وإدارة ١٥٠ مورد\nبكالوريوس محاسبة ٢٠٢٠' }));
  assert.ok(r.cvStrengthScore >= 50, 'got ' + r.cvStrengthScore);
  assert.ok(r.jobFitScore > 30);
});
