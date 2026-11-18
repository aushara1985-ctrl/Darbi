'use strict';
// Builds test sessions from the JSON banks, hides answer keys, grades submissions, and writes reports.
// Pure (no I/O) apart from require()ing the banks.

const ws = require('./bank/workstyle.json');
const apt = require('./bank/aptitude.json');
const sjt = require('./bank/sjt.json');
const iv = require('./bank/interview.json');
const tracksCfg = require('./bank/tracks.json');
const S = require('./scoring');

const TRACKS = Object.keys(tracksCfg.tracks);
const TESTS = tracksCfg.tests;
const FAMILIES = Object.keys(iv.roles);

// ─── deterministic shuffle so a session always yields the same order ───────────
function hashSeed(str) { let h = 1779033703 ^ String(str).length; for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); } return h >>> 0; }
function rng(seed) { let a = hashSeed(seed); return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffle(arr, seed) { const r = rng(seed), a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ─── lookup tables by item id ──────────────────────────────────────────────────
const LOOKUP = new Map();
for (const i of ws.items) LOOKUP.set(i.id, { type: 'likert', ...i });
for (const i of apt.numerical) LOOKUP.set(i.id, { type: 'mcq', section: 'numerical', ...i });
for (const i of apt.verbal) LOOKUP.set(i.id, { type: 'mcq', section: 'verbal', ...i, opts: null, verbal: true });
for (const i of apt.logical) LOOKUP.set(i.id, { type: 'mcq', section: 'logical', ...i });
for (const i of apt.english) LOOKUP.set(i.id, { type: 'mcq', section: 'english', ...i });
for (const i of sjt.items) LOOKUP.set(i.id, { type: 'sjt', ...i });
for (const i of iv.openers) LOOKUP.set(i.id, { type: 'interview', kind: 'opener', ...i });
for (const i of iv.competency) LOOKUP.set(i.id, { type: 'interview', kind: 'behavioural', ...i });
for (const i of iv.situational) LOOKUP.set(i.id, { type: 'interview', kind: 'situational', ...i });
for (const i of iv.closers) LOOKUP.set(i.id, { type: 'interview', kind: 'closer', ...i });
for (const [fam, def] of Object.entries(iv.roles)) for (const q of def.q) LOOKUP.set(q.id, { type: 'interview', kind: 'role', family: fam, ...q });

function levelsForTrack(track) {
  if (track === 'fresh_grad') return ['fresh_grad'];
  if (track === 'career_changer') return ['career_changer', 'junior', 'mid'];
  if (track === 'experienced') return ['mid', 'senior'];
  return ['simple_job', 'fresh_grad'];
}
function normFamily(f) { return FAMILIES.includes(f) ? f : 'general_entry'; }
function normTrack(t) { return TRACKS.includes(t) ? t : 'fresh_grad'; }

// Pick `n` competency questions with distinct competencies first, honouring the track level.
function pickCompetency(track, n, seed, exclude = []) {
  const lv = levelsForTrack(track);
  const pool = iv.competency.filter((q) => q.lv.some((l) => lv.includes(l)) && !exclude.includes(q.id));
  const sh = shuffle(pool, seed);
  const out = [], seen = new Set();
  for (const q of sh) { if (out.length >= n) break; if (!seen.has(q.c)) { seen.add(q.c); out.push(q.id); } }
  for (const q of sh) { if (out.length >= n) break; if (!out.includes(q.id)) out.push(q.id); }
  return out;
}
function pickRole(family, n, seed) {
  const own = iv.roles[family].q.map((q) => q.id);
  const out = own.slice(0, n);
  if (out.length < n) for (const id of shuffle(iv.roles.general_entry.q.map((q) => q.id), seed)) { if (out.length >= n) break; if (!out.includes(id)) out.push(id); }
  return out;
}

// ─── item selection per test ───────────────────────────────────────────────────
function selectItemIds(test, { track, family, seed }) {
  const f = normFamily(family), t = normTrack(track);
  switch (test) {
    case 'diagnostic':
      return [
        'ws01', 'ws06', 'ws02', 'ws07', 'ws03', 'ws08', 'ws04', 'ws09',
        'sjt01', 'sjt02', 'sjt04',
        'num01', 'num03', 'num05',
        'ver01', 'ver05', 'ver10',
        'log01', 'log06',
        'eng01', 'eng06', 'eng08',
      ];
    case 'workstyle45': return shuffle(ws.items.map((i) => i.id), seed);
    case 'sjt_set_1': return shuffle(sjt.meta.sets.sjt_set_1, seed);
    case 'sjt_set_2': return shuffle(sjt.meta.sets.sjt_set_2, seed);
    case 'numerical': return shuffle(apt.numerical.map((i) => i.id), seed);
    case 'verbal': return apt.verbal.map((i) => i.id); // keep passage order
    case 'logical': return shuffle(apt.logical.map((i) => i.id), seed);
    case 'english': return shuffle(apt.english.map((i) => i.id), seed);
    case 'interview_quick':
      return ['op01', pickCompetency(t, 1, seed)[0], pickRole(f, 1, seed)[0], 'si01', 'op04', 'cl01'];
    case 'interview_competency':
      return pickCompetency(t, 10, seed);
    case 'interview_role':
      return [...pickRole(f, 3, seed), ...pickCompetency(t, 3, seed + 'r'), 'si01', 'si02', 'si03'];
    case 'mock_final': {
      const bp = iv.mockBlueprint[t];
      const ops = ['op01', 'op02', 'op03'].slice(0, bp.openers);
      const comp = pickCompetency(t, bp.competency, seed);
      const role = pickRole(f, bp.role, seed);
      const sit = ['si01', 'si02', 'si03'].slice(0, bp.situational);
      const cl = ['cl01', 'cl02'].slice(0, bp.closers);
      return [...ops, ...comp, ...role, ...sit, ...cl];
    }
    default: return null;
  }
}

function minutesFor(test) { return (TESTS[test] || {}).minutes || 15; }

// ─── public (key-free) rendering ───────────────────────────────────────────────
function publicItem(id) {
  const it = LOOKUP.get(id);
  if (!it) return null;
  if (it.type === 'likert') return { id, type: 'likert', en: it.en, ar: it.ar, scale: ws.meta.scale };
  if (it.type === 'mcq') {
    const out = { id, type: 'mcq', section: it.section, en: it.en, ar: it.ar };
    if (it.verbal) { out.passage = apt.passages[it.p]; out.opts = apt.verbalOpts; }
    else if (it.section === 'english') { out.opts = { en: it.opts, ar: it.opts }; }
    else { out.opts = { en: it.opts, ar: it.opts }; }
    return out;
  }
  if (it.type === 'sjt') return { id, type: 'sjt', en: it.en, ar: it.ar, opts: it.opts.map((o) => ({ en: o.en, ar: o.ar })), instruction: sjt.meta.instruction };
  if (it.type === 'interview') {
    const out = { id, type: 'interview', kind: it.kind, en: it.en, ar: it.ar };
    if (it.c) out.competency = { id: it.c, ...iv.competencies[it.c] };
    if (it.tip) out.tip = it.tip;
    if (it.kind === 'behavioural') out.star = iv.star;
    return out;
  }
  return null;
}

// ─── session creation ──────────────────────────────────────────────────────────
function buildSession({ test, track, lang, family, timed, sessionId }) {
  if (!TESTS[test]) return { error: 'unknown_test' };
  const seed = String(sessionId || Date.now());
  const ids = selectItemIds(test, { track, family, seed });
  if (!ids) return { error: 'unknown_test' };
  const meta = TESTS[test];
  return {
    test, kind: meta.kind, track: normTrack(track), family: normFamily(family),
    lang: lang === 'en' ? 'en' : 'ar', itemIds: ids,
    timeLimitSec: timed ? minutesFor(test) * 60 : null,
  };
}

// ─── grading ───────────────────────────────────────────────────────────────────
function section(ids, type) { return ids.map((id) => LOOKUP.get(id)).filter((i) => i && (!type || i.type === type)); }
const L = (ar, en) => ({ ar, en });

function gradeDiagnostic(session, answers, timing) {
  const ids = session.itemIds;
  const sjtItems = section(ids, 'sjt');
  const mcq = section(ids, 'mcq');
  const bySec = {};
  for (const it of mcq) (bySec[it.section] = bySec[it.section] || []).push(it);
  const sections = {};
  for (const [name, items] of Object.entries(bySec)) {
    const r = S.scoreMCQ(items, answers, timing);
    sections[name] = { pct: r.pct, correct: r.correct, total: r.total, level: r.level };
  }
  const sj = S.scoreSJT(sjtItems, answers);
  sections.sjt = { pct: sj.pct, total: sj.total, level: sj.level };
  // work-style sample: tendencies only
  const lik = section(ids, 'likert'); const tr = {};
  for (const it of lik) { const v = answers[it.id]; if (!Number.isInteger(v)) continue; const x = it.r ? 6 - v : v; (tr[it.t] = tr[it.t] || []).push(x); }
  const tendencies = {};
  for (const [t, a] of Object.entries(tr)) tendencies[t] = { score: Math.round(((a.reduce((s, x) => s + x, 0) / a.length - 1) / 4) * 100) };
  const levels = Object.entries(sections).map(([k, v]) => ({ k, pct: v.pct })).sort((a, b) => a.pct - b.pct);
  const weakest = levels.slice(0, 2).map((x) => x.k);
  const track = tracksCfg.tracks[session.track];
  const order = track.path.filter((x) => x !== 'diagnostic');
  const sectionToTest = { numerical: 'numerical', verbal: 'verbal', logical: 'logical', english: 'english', sjt: 'sjt_set_1' };
  const first = weakest.map((w) => sectionToTest[w]).filter((t) => order.includes(t) || t === 'sjt_set_1');
  const plan = [...new Set([...first, ...order])];
  const pct = Math.round(levels.reduce((s, x) => s + x.pct, 0) / Math.max(1, levels.length));
  return { kind: 'diagnostic', pct, sections, tendencies, weakest, recommendedPlan: plan, indicative: true };
}

function gradeInterview(session, answers) {
  const ids = session.itemIds;
  const results = [];
  const fam = session.family;
  for (const id of ids) {
    const it = LOOKUP.get(id);
    const given = answers[id];
    const kw = it.kind === 'role' ? (iv.roles[it.family] || iv.roles[fam]).kw : (iv.roles[fam] ? iv.roles[fam].kw : []);
    const res = S.scoreInterviewAnswer(given || '', { lang: session.lang, kind: it.kind === 'behavioural' ? 'behavioural' : (it.kind === 'situational' ? 'behavioural' : 'role'), keywords: it.kind === 'role' ? kw : [] });
    results.push({ id, kind: it.kind, c: it.c, res, question: { en: it.en, ar: it.ar } });
  }
  const summary = S.summariseInterview(results.map((r) => ({ ...r, kind: r.kind === 'behavioural' || r.kind === 'situational' ? 'behavioural' : r.kind })));
  return { kind: 'interview', pct: summary.avg, items: results, summary, lang: session.lang };
}

function grade(session, answers, timing = {}) {
  answers = answers || {};
  const ids = session.itemIds;
  if (session.test === 'diagnostic') return gradeDiagnostic(session, answers, timing);
  if (session.kind === 'likert') {
    const r = S.scoreWorkStyle(answers, { family: session.family });
    return { kind: 'likert', pct: r.valid ? r.profileFit : null, ...r };
  }
  if (session.kind === 'sjt') {
    const r = S.scoreSJT(section(ids, 'sjt'), answers);
    return { kind: 'sjt', ...r };
  }
  if (session.kind === 'mcq') {
    const items = section(ids, 'mcq');
    const r = S.scoreMCQ(items, answers, { limitSec: session.timeLimitSec, usedSec: timing.usedSec });
    return { kind: 'mcq', section: session.test, ...r };
  }
  if (session.kind === 'interview') return gradeInterview(session, answers);
  return { error: 'cannot_grade' };
}

// ─── report ────────────────────────────────────────────────────────────────────
function nextStepsFor(session, result) {
  const steps = [];
  const add = (ar, en) => steps.push({ ar, en });
  if (result.kind === 'mcq') {
    if (result.level === 'needs_practice' || result.level === 'developing') add('راجع الشرح لكل سؤال أخطأت فيه ثم أعد الاختبار بعد يومين.', 'Read the explanation for every question you missed, then retake in two days.');
    if (result.unanswered > 0) add('أجبت عن عدد أقل من الأسئلة. في الاختبارات الحقيقية التخمين أفضل من ترك السؤال فارغاً.', 'You left questions blank. In real tests an educated guess beats a blank.');
    if (result.overtime) add('تجاوزت الوقت. تدرّب بوضع الوقت وحدد حداً أقصى لكل سؤال.', 'You went over time. Practise in timed mode with a per-question limit.');
    if (result.level === 'strong') add('مستواك قوي. انتقل للمرحلة التالية في المسار.', 'Strong result. Move on to the next step in your path.');
  } else if (result.kind === 'sjt') {
    add('اقرأ تفسير كل موقف: غالباً الأفضل هو التواصل المبكر ثم الحل، وليس الصمت ولا التصعيد المباشر.', 'Read each explanation: the best answer is usually early communication then a fix, not silence or instant escalation.');
  } else if (result.kind === 'likert') {
    if (!result.valid) add('أكمل 90% على الأقل من البنود لتظهر النتيجة.', 'Answer at least 90% of the items to get a result.');
    else {
      if (!result.reliable) add('ظهرت علامات في نمط إجاباتك (مبالغة في الصورة المثالية أو عدم اتساق). أعد الاختبار بصدق أكبر؛ هذا ما يلاحظه أصحاب العمل.', 'Your pattern showed warning signs (too perfect or inconsistent). Retake more candidly; employers notice this.');
      const below = Object.entries(result.traits).filter(([, v]) => v.fit !== 'in_range');
      if (below.length) add('بعض الأبعاد خارج نطاق الدور المستهدف. جهّز مثالين واقعيين يوضحان كيف تعمل في هذه الجوانب.', 'Some traits sit outside the typical range for your target role. Prepare two real examples showing how you work in those areas.');
    }
  } else if (result.kind === 'interview') {
    for (const t of (result.summary.topTips || [])) add(t.ar, t.en);
    if (result.summary.weakest[0]) add('أضعف كفاءة لديك الآن: ' + (iv.competencies[result.summary.weakest[0].c] || {}).ar + '. جهّز قصة STAR واحدة لها.', 'Your weakest competency now: ' + (iv.competencies[result.summary.weakest[0].c] || {}).en + '. Prepare one STAR story for it.');
    add('كرّر الأسئلة التي حصلت فيها على أقل من 60 وسجّل نفسك صوتياً.', 'Repeat the questions you scored below 60 and record yourself speaking.');
  } else if (result.kind === 'diagnostic') {
    add('مسارك المقترح مرتب حسب نقاط ضعفك. ابدأ بأول خطوتين.', 'Your suggested path is ordered by your weakest areas. Start with the first two steps.');
  }
  return steps.slice(0, 5);
}

function buildReport(session, result) {
  const meta = TESTS[session.test];
  const note = {
    interview: L('التقييم يفحص بنية الإجابة (STAR، الأرقام، "أنا" مقابل "نحن"، الوضوح، اللغة) ولا يحكم على صحة المحتوى أو جودة خبرتك. قيّم نفسك أيضاً بصوت مسموع أو مع صديق.', 'Scoring checks answer structure (STAR, numbers, I vs we, clarity, language), not whether the content is true or how strong your experience is. Also rehearse aloud or with a friend.'),
    mcq: L('النسبة تدريبية ولا تقارن بمعايير جهات توظيف، فكل جهة تحدد درجة النجاح بنفسها.', 'This percentage is for practice. It is not compared with any employer norm; each employer sets its own pass mark.'),
    sjt: L('مفتاح التقييم من معيار درْبي التدريبي وليس مفتاح جهة توظيف بعينها.', 'The key is Darbi\'s practice rubric, not a specific employer\'s key.'),
    likert: L('لا توجد إجابات صحيحة. هذه قراءة تقريبية لكيفية فهم صاحب العمل لإجاباتك، وليست تشخيصاً نفسياً.', 'There are no right answers. This is an approximate reading of how an employer may interpret your answers, not a psychological diagnosis.'),
    diagnostic: L('نتيجة تقريبية من عدد قليل من الأسئلة تُستخدم لبناء خطتك فقط.', 'An indicative result from few questions, used only to build your plan.'),
  }[result.kind];
  return {
    test: session.test, title: { en: meta.en, ar: meta.ar }, track: session.track, lang: session.lang,
    result, nextSteps: nextStepsFor(session, result), honestyNote: note,
    explanations: explanationsFor(session),
  };
}

function explanationsFor(session) {
  if (!['mcq', 'sjt', 'mixed'].includes(session.kind)) return undefined;
  const out = {};
  for (const id of session.itemIds) { const it = LOOKUP.get(id); if (it && it.x) out[id] = it.x; }
  return out;
}

module.exports = { buildSession, publicItem, grade, buildReport, minutesFor, TESTS, TRACKS, FAMILIES, LOOKUP, normFamily, normTrack, tracksCfg };
