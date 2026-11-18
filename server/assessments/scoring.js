'use strict';
// Pure scoring functions for Darbi assessments. No I/O, no Express, no DB.
// Honesty rule: every score here is a PRACTICE score. Aptitude has no employer norms;
// interview scoring checks answer STRUCTURE (STAR, specifics, ownership, clarity),
// not whether the content is true or impressive. Reports say so.

const workstyle = require('./bank/workstyle.json');
const interviewBank = require('./bank/interview.json');
const tracksCfg = require('./bank/tracks.json');

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round = (n, d = 0) => { const f = 10 ** d; return Math.round(n * f) / f; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const stdev = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

// ───────────────────────── Work-style inventory ─────────────────────────────
function bandOf(score) {
  if (score <= workstyle.bands.low.max) return 'low';
  if (score <= workstyle.bands.mid.max) return 'mid';
  return 'high';
}

function roleGroupForFamily(family) {
  for (const [g, def] of Object.entries(workstyle.roleProfiles)) {
    if (def.families.includes(family)) return g;
  }
  return 'general';
}

// answers: { ws01: 1..5, ... }
function scoreWorkStyle(answers, opts = {}) {
  const family = opts.family || 'general_entry';
  const items = workstyle.items;
  const answered = items.filter((i) => Number.isInteger(answers[i.id]) && answers[i.id] >= 1 && answers[i.id] <= 5);
  const completeness = answered.length / items.length;
  if (completeness < 0.9) {
    return { valid: false, reason: 'incomplete', completeness: round(completeness, 2), answered: answered.length, total: items.length };
  }
  const val = (i) => (i.r ? 6 - answers[i.id] : answers[i.id]);
  const byTrait = {};
  for (const i of answered) (byTrait[i.t] = byTrait[i.t] || []).push(i);

  const traits = {};
  let inconsistentTraits = 0;
  for (const t of Object.keys(workstyle.traits)) {
    const list = byTrait[t] || [];
    if (!list.length) continue;
    const m = mean(list.map(val));
    const score = round(((m - 1) / 4) * 100);
    // consistency: positively keyed vs reverse keyed items (after flipping) should agree.
    const pos = list.filter((i) => !i.r).map(val);
    const rev = list.filter((i) => i.r).map(val);
    const gap = pos.length && rev.length ? Math.abs(mean(pos) - mean(rev)) : 0;
    const inconsistent = gap > 1.5;
    if (inconsistent) inconsistentTraits++;
    traits[t] = { score, band: bandOf(score), consistencyGap: round(gap, 2), inconsistent };
  }

  // Impression management: the D items are impossible virtues.
  const dItems = byTrait.D || [];
  const dMean = dItems.length ? mean(dItems.map(val)) : 0;
  const impressionManagement = dItems.length >= 3 && dMean >= 4.4;

  // Straight-lining / acquiescence (same answer for nearly everything).
  const raw = answered.map((i) => answers[i.id]);
  const spread = stdev(raw);
  const straightLining = spread < 0.45;

  const group = roleGroupForFamily(family);
  const target = workstyle.roleProfiles[group].target;
  const reading = {};
  for (const [t, def] of Object.entries(traits)) {
    const [lo, hi] = target[t];
    const fit = def.score < lo ? 'below' : def.score > hi ? 'above' : 'in_range';
    reading[t] = { ...def, target: [lo, hi], fit, employerRead: workstyle.reading[t][def.band] };
  }
  const inRange = Object.values(reading).filter((r) => r.fit === 'in_range').length;
  const profileFit = round((inRange / Object.keys(reading).length) * 100);

  const flags = [];
  if (impressionManagement) flags.push('impression_management');
  if (straightLining) flags.push('straight_lining');
  if (inconsistentTraits >= 2) flags.push('inconsistent');
  const reliable = flags.length === 0;

  return {
    valid: true, completeness: round(completeness, 2), traits: reading, roleGroup: group,
    profileFit, flags, reliable, desirabilityMean: round(dMean, 2), spread: round(spread, 2),
    notes: workstyle.honestyNotes,
  };
}

// ───────────────────────── Multiple choice (aptitude / english) ─────────────
// items: [{id,a,d?}], answers: {id: optionIndex|null}, timing: {limitSec, usedSec}
function scoreMCQ(items, answers, timing = {}) {
  let correct = 0, answered = 0, wrong = 0;
  const detail = [];
  for (const it of items) {
    const given = answers[it.id];
    const has = Number.isInteger(given);
    if (has) answered++;
    const ok = has && given === it.a;
    if (ok) correct++; else if (has) wrong++;
    detail.push({ id: it.id, given: has ? given : null, correct: it.a, ok });
  }
  const total = items.length;
  const pct = total ? round((correct / total) * 100) : 0;
  const accuracyOfAnswered = answered ? round((correct / answered) * 100) : 0;
  let overtime = false;
  if (timing.limitSec && timing.usedSec) overtime = timing.usedSec > timing.limitSec + 15;
  const avgSecPerItem = timing.usedSec && answered ? round(timing.usedSec / answered) : null;
  return { correct, wrong, unanswered: total - answered, total, pct, accuracyOfAnswered, overtime, avgSecPerItem, detail, level: aptitudeLevel(pct) };
}

function aptitudeLevel(pct) {
  // NOT an employer norm. Practice levels only.
  if (pct >= 80) return 'strong';
  if (pct >= 60) return 'solid';
  if (pct >= 40) return 'developing';
  return 'needs_practice';
}

// ───────────────────────── Situational judgement ────────────────────────────
// items: [{id, opts:[{r}]}], answers: {id: {most: idx, least: idx}}
function scoreSJT(items, answers) {
  let sum = 0, scored = 0;
  const detail = [];
  const byCompetency = {};
  for (const it of items) {
    const a = answers[it.id];
    const ok = a && Number.isInteger(a.most) && Number.isInteger(a.least) && a.most !== a.least && it.opts[a.most] && it.opts[a.least];
    if (!ok) { detail.push({ id: it.id, score: 0, answered: false }); continue; }
    const best = Math.max(...it.opts.map((o) => o.r));
    const worst = Math.min(...it.opts.map((o) => o.r));
    const mostPts = (it.opts[a.most].r - worst) / (best - worst);   // 1 when picked a best option
    const leastPts = (best - it.opts[a.least].r) / (best - worst);  // 1 when picked a worst option
    const s = 0.5 * mostPts + 0.5 * leastPts;
    sum += s; scored++;
    detail.push({ id: it.id, score: round(s, 2), answered: true, most: a.most, least: a.least,
      bestIdx: it.opts.findIndex((o) => o.r === best), worstIdx: it.opts.findIndex((o) => o.r === worst) });
    if (it.c) { (byCompetency[it.c] = byCompetency[it.c] || []).push(s); }
  }
  const pct = items.length ? round((sum / items.length) * 100) : 0;
  const comp = {};
  for (const [c, arr] of Object.entries(byCompetency)) comp[c] = round(mean(arr) * 100);
  return { pct, answered: scored, total: items.length, detail, byCompetency: comp, level: aptitudeLevel(pct) };
}

// ───────────────────────── Interview answers ────────────────────────────────
const RX = {
  numbers: /(\d+[\d.,]*\s*%?)|(\b(one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million)\b)|(واحد|اثنين|ثلاث|أربع|خمس|ست|سبع|ثمان|تسع|عشر|مئة|مائة|ألف|مليون)/i,
  situation: /\b(when|while|during|at my|in my|last (year|month|semester)|once|at university|at work|in 20\d\d)\b|عندما|حين|أثناء|خلال|في (الجامعة|عملي|شركة|مشروع)|كنت (أعمل|في)|السنة الماضية|مرة/i,
  task: /\b(my (role|job|task|responsibility|goal)|i (was|am) (responsible|asked|assigned|in charge)|i needed to|i had to|the goal was|the challenge)\b|مسؤولي|مهمتي|كان (علي|عليّ|المطلوب)|كلفت|كُلّفت|الهدف كان|التحدي/i,
  action: /\b(i (decided|created|built|organi[sz]ed|asked|talked|spoke|started|called|wrote|prepared|planned|analy[sz]ed|set up|proposed|suggested|checked|fixed|led|explained|listened|offered|stayed|worked))\b|قمت|بدأت|نظمت|تواصلت|اتصلت|كتبت|حضرت|خططت|حللت|اقترحت|راجعت|أصلحت|قدت|شرحت|استمعت|عرضت|عملت/i,
  result: /\b(as a result|result(ed)?|so that|which (led|meant|helped)|increased|reduced|improved|saved|delivered|achieved|learned|lesson|feedback|succeeded|won)\b|نتيجة|والنتيجة|ما أدى|أدى إلى|زاد|زادت|انخفض|تحسن|وفّر|حققت|تعلمت|الدرس|نجح|أنجزنا|أنجزت/i,
  iStatements: /\b(i|my|me)\b|\bأنا\b|\bقمت\b|\bبدأت\b|\bقررت\b|\bكنت\b|\bعملت\b|\bنظمت\b|\bتواصلت\b/gi,
  weStatements: /\b(we|our|us)\b|\bنحن\b|\bفريقنا\b|\bقمنا\b|\bعملنا\b/gi,
  fillers: /\b(um+|uh+|like|you know|basically|kind of|sort of|i guess|maybe)\b|\bيعني\b|\bاممم+\b|\bكذا\b|\bاعتقد\b|\bممكن\b/gi,
  arabicChars: /[؀-ۿ]/g,
  latinChars: /[A-Za-z]/g,
};

function wordsOf(text) { return String(text || '').trim().split(/\s+/).filter(Boolean); }
function count(rx, text) { const m = String(text).match(rx); return m ? m.length : 0; }

// kind: 'behavioural' | 'role' | 'opener' | 'situational' | 'closer'
// Returns { score 0..100, parts:{...}, tips:[{en,ar}], star:{S,T,A,R} }
function scoreInterviewAnswer(input, ctx = {}) {
  const text = typeof input === 'string' ? input : (input && input.text) || '';
  const seconds = typeof input === 'object' && input ? Number(input.seconds) || 0 : 0;
  const lang = ctx.lang === 'en' ? 'en' : 'ar';
  const kind = ctx.kind || 'behavioural';
  const words = wordsOf(text);
  const n = words.length;
  const tips = [];
  const tip = (en, ar) => tips.push({ en, ar });

  if (n < 8) {
    tip('Your answer is too short to assess. Aim for 60 to 150 words (about 45 to 90 seconds spoken).', 'إجابتك أقصر من أن تُقيَّم. استهدف 60 إلى 150 كلمة (حوالي 45 إلى 90 ثانية نطقاً).');
    return { score: n === 0 ? 0 : 10, words: n, parts: { length: 0 }, tips, star: { S: false, T: false, A: false, R: false }, tooShort: true };
  }

  const arPct = count(RX.arabicChars, text) / Math.max(1, text.replace(/\s/g, '').length);
  const wrongLanguage = (lang === 'en' && arPct > 0.3) || (lang === 'ar' && count(RX.latinChars, text) / Math.max(1, text.replace(/\s/g, '').length) > 0.6);

  // length (ideal 60..180 words)
  let lengthPts;
  if (n >= 60 && n <= 180) lengthPts = 1;
  else if (n < 60) lengthPts = clamp((n - 8) / 52, 0, 1);
  else lengthPts = clamp(1 - (n - 180) / 200, 0.4, 1);
  if (n < 60) tip('Add more detail: your answer is short for an interview.', 'أضف تفاصيل أكثر: إجابتك قصيرة بالنسبة لمقابلة.');
  if (n > 220) tip('This is long. Tighten it to about two minutes spoken.', 'الإجابة طويلة. اختصرها إلى حوالي دقيقتين نطقاً.');

  // specifics
  const hasNumber = RX.numbers.test(text);
  const specificsPts = hasNumber ? 1 : 0.3;
  if (!hasNumber) tip('Add a number: how many, how long, how much, or what percent changed.', 'أضف رقماً: كم، كم المدة، كم المبلغ، أو كم النسبة التي تغيّرت.');

  // ownership
  const iCount = count(RX.iStatements, text), weCount = count(RX.weStatements, text);
  const ownershipRatio = (iCount + weCount) ? iCount / (iCount + weCount) : 0.5;
  const ownershipPts = clamp(ownershipRatio / 0.6, 0, 1);
  if (ownershipRatio < 0.3) tip('You say "we" a lot. Say what YOU personally did.', 'تكرر "نحن" كثيراً. قل ما فعلته أنت شخصياً.');

  // clarity
  const fillerCount = count(RX.fillers, text);
  const sentences = String(text).split(/[.!?؟\n]+/).filter((s) => wordsOf(s).length > 0);
  const avgSentence = n / Math.max(1, sentences.length);
  let clarityPts = 1;
  if (fillerCount / n > 0.04) { clarityPts -= 0.35; tip('Too many filler words. Pause instead.', 'كلمات حشو كثيرة. تَوقّف قليلاً بدلاً منها.'); }
  if (avgSentence > 35) { clarityPts -= 0.3; tip('Your sentences are very long. Split them.', 'جملك طويلة جداً. قسّمها.'); }
  if (wrongLanguage) {
    clarityPts = 0;
    if (lang === 'en') tip('This is an English-mode answer: please answer in English.', 'هذا وضع المقابلة بالإنجليزية: أجب بالإنجليزية.');
    else tip('This is an Arabic-mode answer: please answer in Arabic.', 'هذا وضع المقابلة بالعربية: أجب بالعربية.');
  }
  clarityPts = clamp(clarityPts, 0, 1);

  // pace (only when spoken seconds are supplied)
  let paceWpm = null;
  if (seconds > 5) {
    paceWpm = round((n / seconds) * 60);
    if (paceWpm > 190) tip('You speak very fast. Slow down so the interviewer can follow.', 'تتحدث بسرعة كبيرة. أبطئ ليتمكن المحاور من المتابعة.');
    else if (paceWpm < 80) tip('Your pace is slow. Practise to sound more confident.', 'وتيرتك بطيئة. تدرّب لتبدو أكثر ثقة.');
  }

  let parts, score;
  const star = { S: RX.situation.test(text), T: RX.task.test(text), A: RX.action.test(text), R: RX.result.test(text) };
  if (kind === 'behavioural') {
    const starPts = (star.S ? 0.2 : 0) + (star.T ? 0.15 : 0) + (star.A ? 0.35 : 0) + (star.R ? 0.3 : 0);
    if (!star.R) tip('Missing a clear result: say what changed because of what you did.', 'ينقصك نتيجة واضحة: قل ما الذي تغيّر بسبب ما فعلته.');
    if (!star.S) tip('Set the scene first: where and when.', 'مهّد للموقف أولاً: أين ومتى.');
    if (!star.A) tip('Describe your own actions step by step.', 'صف أفعالك أنت خطوة بخطوة.');
    parts = { length: round(lengthPts * 15), star: round(starPts * 45), ownership: round(ownershipPts * 10), specifics: round(specificsPts * 15), clarity: round(clarityPts * 15) };
  } else {
    const kw = (ctx.keywords || []).map((k) => String(k).toLowerCase());
    const low = text.toLowerCase();
    const hits = kw.filter((k) => low.includes(k)).length;
    const kwPts = kw.length ? clamp(hits / 3, 0, 1) : 0.6;
    if (kw.length && hits < 2) tip('Use more of the language of this field to show you know it.', 'استخدم مصطلحات أكثر من هذا المجال لتُظهر معرفتك به.');
    parts = { length: round(lengthPts * 20), keywords: round(kwPts * 25), ownership: round(ownershipPts * 15), specifics: round(specificsPts * 20), clarity: round(clarityPts * 20) };
  }
  score = clamp(Object.values(parts).reduce((s, x) => s + x, 0), 0, 100);
  if (wrongLanguage) score = Math.min(score, 55);
  return { score: round(score), words: n, parts, tips: tips.slice(0, 4), star, paceWpm, wrongLanguage };
}

// Optional aggregate over a full interview.
// results: [{id, kind, c?, family?, res}]
function summariseInterview(results, ctx = {}) {
  const scored = results.filter((r) => r.res && !r.res.tooShort);
  const avg = results.length ? round(mean(results.map((r) => (r.res ? r.res.score : 0)))) : 0;
  const answeredPct = results.length ? round((results.filter((r) => r.res && r.res.words >= 8).length / results.length) * 100) : 0;
  const byCompetency = {};
  for (const r of results) {
    if (!r.c || !r.res) continue;
    (byCompetency[r.c] = byCompetency[r.c] || []).push(r.res.score);
  }
  const comp = Object.entries(byCompetency).map(([c, a]) => ({ c, score: round(mean(a)) })).sort((a, b) => a.score - b.score);
  const tipCounts = {};
  for (const r of results) for (const t of (r.res && r.res.tips) || []) { const k = t.en; tipCounts[k] = tipCounts[k] || { n: 0, t }; tipCounts[k].n++; }
  const topTips = Object.values(tipCounts).sort((a, b) => b.n - a.n).slice(0, 3).map((x) => x.t);
  const starRate = results.filter((r) => r.kind === 'behavioural' && r.res).length
    ? round((results.filter((r) => r.kind === 'behavioural' && r.res && r.res.star && r.res.star.R).length / results.filter((r) => r.kind === 'behavioural').length) * 100) : null;
  return { avg, answeredPct, weakest: comp.slice(0, 2), strongest: comp.slice(-2).reverse(), topTips, resultRate: starRate, count: results.length, scored: scored.length };
}

// ───────────────────────── Readiness score ──────────────────────────────────
// attempts: [{test, kind, pct (0..100), createdAt, lang}] — uses best of the most recent 3 per group.
const GROUP_OF_TEST = {
  numerical: 'aptitude', verbal: 'aptitude', logical: 'aptitude',
  workstyle45: 'workstyle', sjt_set_1: 'sjt', sjt_set_2: 'sjt',
  interview_quick: 'interview', interview_competency: 'interview', interview_role: 'interview', mock_final: 'interview',
  english: 'english',
};
function readiness(attempts) {
  const W = tracksCfg.readinessWeights;
  const groups = {};
  for (const a of attempts) {
    let g = GROUP_OF_TEST[a.test];
    if (a.test === 'diagnostic') continue; // diagnostic feeds the plan, not the score
    if (!g || typeof a.pct !== 'number') continue;
    const key = g === 'aptitude' ? 'aptitude:' + a.test : g;
    (groups[key] = groups[key] || []).push(a);
  }
  const comp = {};
  const pick = (arr) => {
    const recent = arr.slice().sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt)).slice(0, 3);
    return Math.max(...recent.map((r) => r.pct));
  };
  const aptKeys = Object.keys(groups).filter((k) => k.startsWith('aptitude:'));
  if (aptKeys.length) comp.aptitude = round(mean(aptKeys.map((k) => pick(groups[k]))));
  for (const g of ['workstyle', 'sjt', 'interview', 'english']) if (groups[g]) comp[g] = round(pick(groups[g]));
  const totalW = Object.keys(comp).reduce((s, g) => s + W[g], 0);
  const allW = Object.values(W).reduce((s, x) => s + x, 0);
  const score = totalW ? round(Object.entries(comp).reduce((s, [g, v]) => s + v * W[g], 0) / totalW) : 0;
  const coverage = round((totalW / allW) * 100);
  const mock = (groups.interview || []).some((x) => x.test === 'mock_final');
  let band = score >= 75 ? 'ready' : score >= 60 ? 'nearly' : score >= 40 ? 'building' : 'early';
  if (coverage < 60 || !mock) { if (band === 'ready') band = 'nearly'; }
  return {
    score, band, coverage, components: comp, provisional: coverage < 60,
    missing: Object.keys(W).filter((g) => !(g in comp)),
    note: { en: 'Practice readiness, not a prediction of any employer decision. It needs at least 60% coverage and a mock final interview to reach "ready".', ar: 'جاهزية تدريبية وليست توقعاً لقرار أي جهة توظيف. تحتاج تغطية 60% على الأقل ومقابلة نهائية تجريبية للوصول إلى "جاهز".' },
  };
}

module.exports = {
  scoreWorkStyle, scoreMCQ, scoreSJT, scoreInterviewAnswer, summariseInterview, readiness,
  aptitudeLevel, roleGroupForFamily, bandOf, GROUP_OF_TEST,
};
