// CV writer: no invention, honest non-AI fallback, 4 templates, assistant edits.
// The AI client is a stub, so these run offline. Run: node --test server/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const cw = require('./cvWriter');

const SOURCE = [
  'سارة العتيبي',
  'الرياض · 0551234567 · sara@example.com',
  'التعليم',
  'بكالوريوس إدارة أعمال، جامعة الملك سعود، 2023',
  'الخبرات',
  'تدريب تعاوني في شركة الاتصالات لمدة 6 أشهر، خدمة العملاء',
  'رديت على استفسارات العملاء ورفعت رضاهم 15%',
  'المهارات',
  'Excel، خدمة العملاء، التواصل',
].join('\n');

const goodCv = () => ({
  name: 'سارة العتيبي', headline: 'أخصائية خدمة عملاء',
  contact: { email: 'sara@example.com', phone: '0551234567', city: 'الرياض' },
  summary: 'خريجة إدارة أعمال 2023 مع تدريب تعاوني في خدمة العملاء.',
  experience: [{ title: 'متدربة خدمة عملاء', company: 'شركة الاتصالات', start: '', end: '', bullets: ['الرد على استفسارات العملاء ورفع رضاهم 15%'] }],
  education: [{ degree: 'بكالوريوس إدارة أعمال', school: 'جامعة الملك سعود', year: '2023' }],
  skills: ['Excel', 'خدمة العملاء', 'التواصل'],
});

test('templates: exactly 4, each with an Arabic name and a section order', () => {
  assert.strictEqual(cw.TEMPLATES.length, 4);
  for (const t of cw.TEMPLATES) {
    assert.ok(t.id && t.ar && t.desc);
    assert.ok(t.order.includes('experience') && t.order.includes('education') && t.order.includes('skills'));
  }
  assert.strictEqual(new Set(cw.TEMPLATES.map(t => t.id)).size, 4);
});

test('recommendation follows the goal', () => {
  assert.strictEqual(cw.recommendTemplate('new_grad').template, 'graduate');
  assert.strictEqual(cw.recommendTemplate('promotion').template, 'executive');
  assert.strictEqual(cw.recommendTemplate('career_change').template, 'skills');
  assert.strictEqual(cw.recommendTemplate('target_role').template, 'classic');
  assert.strictEqual(cw.recommendTemplate('nonsense').template, 'classic');
  for (const g of Object.keys(cw.GOALS)) assert.ok(cw.recommendTemplate(g).reason.length > 10);
});

test('guard: numbers the person never wrote are flagged; their own numbers pass (Arabic digits too)', () => {
  const cv = cw.normalizeCv(goodCv());
  assert.deepStrictEqual(cw.findUnsupportedNumbers(cv, SOURCE), []);
  cv.experience[0].bullets.push('زيادة المبيعات بنسبة 40% وإدارة فريق من 12 موظف');
  assert.deepStrictEqual(cw.findUnsupportedNumbers(cv, SOURCE).sort(), ['12', '40']);
  const ar = cw.normalizeCv({ summary: 'خبرة ٥ سنوات', experience: [{ title: 'x', bullets: ['رفع الرضا ١٥٪'] }] });
  assert.deepStrictEqual(cw.findUnsupportedNumbers(ar, 'عندي 5 سنوات ورفعت الرضا 15%'), []);
});

test('guard: stripUnsupported removes only the invented lines', () => {
  const cv = cw.normalizeCv(goodCv());
  cv.experience[0].bullets.push('زيادة المبيعات بنسبة 40%');
  const removed = cw.stripUnsupported(cv, SOURCE);
  assert.strictEqual(removed, 1);
  assert.deepStrictEqual(cv.experience[0].bullets, ['الرد على استفسارات العملاء ورفع رضاهم 15%']);
});

test('generate: asks for the source instead of writing from nothing', async () => {
  const r = await cw.generateCv({ goal: 'new_grad', sourceText: 'قصير' }, { chat: async () => ({}) });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, 'source_too_short');
});

test('generate: AI path returns both languages, missing questions and the recommended template', async () => {
  const calls = [];
  const chat = async (messages) => {
    calls.push(messages);
    const sys = messages[0].content;
    assert.ok(/Never add an employer/.test(sys), 'the no-invention rule is in the prompt');
    assert.ok(messages[1].content.includes('سارة العتيبي'), 'the person\'s own text is the source');
    return { cv: goodCv(), missing: ['متى بدأ وانتهى تدريبك التعاوني؟'] };
  };
  const r = await cw.generateCv({ goal: 'new_grad', targetRole: 'خدمة عملاء', country: 'السعودية', language: 'both', sourceText: SOURCE }, { chat });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.ai, true);
  assert.deepStrictEqual(r.languages, ['ar', 'en']);
  assert.ok(r.cv.ar && r.cv.en);
  assert.strictEqual(r.recommendedTemplate, 'graduate');
  assert.deepStrictEqual(r.missing, ['متى بدأ وانتهى تدريبك التعاوني؟']);
  assert.strictEqual(calls.length, 2, 'one call per language');
  assert.strictEqual(r.templates.length, 4);
});

test('generate: invented figures trigger one corrective retry, then are stripped', async () => {
  let n = 0;
  const chat = async (messages) => {
    n++;
    const cv = goodCv();
    cv.experience[0].bullets.push('خفض وقت الانتظار 37%');   // invented, both times
    if (n === 2) assert.ok(/invented: .*37/.test(messages[messages.length - 1].content));
    return { cv, missing: [] };
  };
  const r = await cw.generateCv({ goal: 'target_role', language: 'ar', sourceText: SOURCE }, { chat });
  assert.strictEqual(n, 2);
  assert.strictEqual(r.ai, true);
  assert.ok(!JSON.stringify(r.cv.ar).includes('37'), 'the invented number never reaches the person');
  assert.strictEqual(r.warnings.length, 1);
});

test('generate: answers to "missing" questions become allowed facts', async () => {
  const chat = async () => { const cv = goodCv(); cv.experience[0].start = '2022'; return { cv }; };
  const without = await cw.generateCv({ goal: 'new_grad', language: 'ar', sourceText: SOURCE }, { chat });
  assert.ok(!JSON.stringify(without.cv.ar.experience[0].bullets).includes('2022'));
  const withAns = await cw.generateCv({ goal: 'new_grad', language: 'ar', sourceText: SOURCE,
    answers: [{ question: 'متى بدأ تدريبك؟', answer: 'بدأ في 2022' }] }, { chat });
  assert.strictEqual(withAns.cv.ar.experience[0].start, '2022');
  assert.strictEqual(withAns.warnings.length, 0);
});

test('generate: no AI key -> clearly labelled non-AI copy made only of the person\'s lines', async () => {
  const r = await cw.generateCv({ goal: 'new_grad', language: 'both', sourceText: SOURCE }, { chat: null });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.ai, false);
  assert.strictEqual(r.label, cw.FALLBACK_LABEL);
  assert.ok(/بدون ذكاء اصطناعي/.test(r.label));
  const cv = r.cv.ar;
  assert.strictEqual(cv.name, 'سارة العتيبي');
  assert.strictEqual(cv.contact.email, 'sara@example.com');
  assert.ok(cv.skills.includes('Excel'));
  for (const s of cw.cvStrings(cv)) assert.ok(SOURCE.includes(s) || s.split('، ').every(p => SOURCE.includes(p)), 'not from the source: ' + s);
  assert.deepStrictEqual(cw.findUnsupportedNumbers(cv, SOURCE), []);
});

test('generate: an AI failure falls back to the labelled non-AI copy (never an error page, never fake)', async () => {
  let logged = 0;
  const r = await cw.generateCv({ goal: 'promotion', language: 'ar', sourceText: SOURCE }, { chat: async () => { throw new Error('boom'); }, onError: () => { logged++; } });
  assert.strictEqual(r.ai, false);
  assert.strictEqual(r.aiFailed, true);
  assert.ok(r.label);
  assert.strictEqual(logged, 1);
});

test('edit: applies the instruction; facts typed in the instruction are allowed; others are stripped', async () => {
  const cv = cw.normalizeCv(goodCv());
  const chat = async (messages) => {
    assert.ok(messages[1].content.includes('INSTRUCTION: '));
    const next = goodCv(); next.summary = 'خريجة إدارة أعمال 2023.';
    next.experience[0].bullets.push('إدارة فريق من 25 موظف');   // not in CV, not in instruction
    return { cv: next, note: 'قصّرنا الملخص.' };
  };
  const r = await cw.editCv({ cv, lang: 'ar', instruction: 'خله أقصر', sourceText: SOURCE }, { chat });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.cv.summary, 'خريجة إدارة أعمال 2023.');
  assert.ok(!JSON.stringify(r.cv).includes('25'));
  const r2 = await cw.editCv({ cv, lang: 'ar', instruction: 'أضف أني أدرت فريق من 25 موظف', sourceText: SOURCE }, { chat });
  assert.ok(JSON.stringify(r2.cv).includes('25'), 'the person stated it, so it stays');
});

test('edit: without AI it says so and points to manual editing', async () => {
  const r = await cw.editCv({ cv: goodCv(), instruction: 'خله أقصر' }, { chat: null });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, 'assistant_unavailable');
  assert.ok(/عدّل/.test(r.message));
  const e = await cw.editCv({ cv: goodCv(), instruction: '' }, { chat: async () => ({}) });
  assert.strictEqual(e.error, 'missing_instruction');
});

test('normalizeCv: caps sizes and drops junk', () => {
  const cv = cw.normalizeCv({ name: 'x'.repeat(500), experience: [{}, { title: 'A', bullets: [1, null, 'ok'] }], skills: 'nope', projects: [{ name: '', bullets: [] }] });
  assert.strictEqual(cv.name.length, 120);
  assert.strictEqual(cv.experience.length, 1);
  assert.deepStrictEqual(cv.experience[0].bullets, ['ok']);
  assert.deepStrictEqual(cv.skills, []);
  assert.deepStrictEqual(cv.projects, []);
});
