'use strict';
// Darbi interview practice: real evaluation of each answer with GPT-4o.
//
// The deterministic scorer (scoring.scoreInterviewAnswer) only checks the
// SHAPE of an answer (length, STAR words, numbers). This module reads what the
// person actually wrote against the question and returns a score, what was
// good, what to improve and a stronger version built from their own facts.
//
// When the AI is not configured or fails, nothing is hidden: the result keeps
// the structural score and is marked evaluator: 'short' («التقييم المختصر»)
// with a note saying exactly what that means.
//
// deps.chat(messages, opts) -> parsed JSON (throws on failure). Injected so
// this file is unit-testable without the network.

const S = require('./scoring');
const iv = require('./bank/interview.json');

const CHUNK = 5;          // questions per model call
const MIN_WORDS = 8;      // below this the structural scorer already says "too short"
const TIMEOUT_MS = 45000;

const NOTE = {
  ai: {
    ar: 'تقييم دربي بالذكاء الاصطناعي: يقرأ إجابتك مقابل السؤال (المناسبة، المثال، البنية، دورك والنتيجة، الوضوح). ما يتحقق من صحة ما كتبته، ومو بديل عن محاور حقيقي. تدرّب بصوت مسموع بعد.',
    en: 'Darbi AI evaluation: it reads your answer against the question (relevance, example, structure, your role and the result, clarity). It does not verify what you wrote and does not replace a real interviewer.',
  },
  short: {
    ar: 'التقييم المختصر: يفحص بنية الإجابة فقط (الطول، خطوات STAR، الأرقام، الوضوح) وما يقرأ المحتوى، لأن التقييم الكامل بالذكاء الاصطناعي ما اشتغل الحين. أعد المحاولة لاحقاً عشان تحصل التقييم الكامل.',
    en: 'Short evaluation: it checks answer structure only (length, STAR steps, numbers, clarity), not the content, because the full AI evaluation was not available this time. Try again later for the full evaluation.',
  },
};
const LABEL = { ai: { ar: 'تقييم دربي بالذكاء الاصطناعي', en: 'Darbi AI evaluation' }, short: { ar: 'التقييم المختصر', en: 'Short evaluation' } };

function textOf(v) { return typeof v === 'string' ? v : (v && typeof v.text === 'string' ? v.text : ''); }
function wordCount(t) { return String(t || '').trim().split(/\s+/).filter(Boolean).length; }
function _str(v, max) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, max || 400); }
function _list(v, n) { return (Array.isArray(v) ? v : []).map((x) => _str(x, 240)).filter(Boolean).slice(0, n); }
function _score(n) { const x = Math.round(Number(n)); return Number.isFinite(x) ? Math.min(100, Math.max(0, x)) : null; }

// Does the rewritten answer contain a number (2+ digits or a percentage) the person never wrote?
function digits(s) { return String(s || '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)); }
function inventsNumber(better, source) {
  const have = new Set(digits(source).match(/\d+(?:\.\d+)?/g) || []);
  const text = digits(better).replace(/\[[^\]]*\]/g, ' ');         // bracketed prompts are placeholders, not claims
  return (text.match(/\d+(?:\.\d+)?\s*[%٪]?/g) || []).some((m) => {
    const n = m.replace(/[^\d.]/g, '');
    return (n.length >= 2 || /[%٪]/.test(m)) && !have.has(n);
  });
}

function systemPrompt(lang) {
  return [
    'You are an interview coach inside Darbi, an Arabic career app. Evaluate each practice answer honestly against its question, for any job field.',
    'Score each answer 0-100 with this rubric: relevance to the question asked (30), a specific real example or evidence (25), structure (situation, task, action, result for behavioural and situational questions; a clear direct answer for the others) (20), the person\'s own role and the result (15), clarity and length for a spoken interview (10).',
    'An answer that does not address the question scores below 35 even if it is long. A vague answer with no example scores below 55. Do not inflate.',
    'Feedback rules: be specific to THIS answer and quote or point at what the person wrote. "strengths": up to 2 real strengths (empty if none). "improve": up to 2 concrete changes.',
    '"betterAnswer": rewrite the answer so it would score higher, using ONLY the facts the person gave in THIS answer. Never invent numbers, employers, tools, results, a degree, a job or any background (the target field is context for you, not a fact about the person). Where a figure or detail is missing, write a short bracketed prompt for the person to fill, like [اذكر الرقم الفعلي] or [add the real number]. Keep it under 130 words.',
    'If the answer has no usable facts for the question (off-topic or empty of content), do NOT write a story: make "betterAnswer" a fill-in outline of bracketed prompts only, for example: [الموقف: وين ومتى] ثم [مهمتك] ثم [وش سويت أنت خطوة بخطوة] ثم [النتيجة ورقمها].',
    'Write "verdict", "strengths" and "improve" in plain gender-neutral Saudi Arabic. Write "betterAnswer" in ' + (lang === 'en' ? 'English' : 'Arabic') + ' (the language of the interview).',
    'Return JSON only: { "results": [ { "id": "<question id>", "score": 0, "verdict": "جملة قصيرة", "strengths": [""], "improve": [""], "betterAnswer": "" } ] } with one entry per question id you were given.',
  ].join('\n');
}

function userPrompt(chunk, ctx) {
  const lines = [];
  if (ctx.role) lines.push('TARGET ROLE / FIELD: ' + ctx.role);
  lines.push('INTERVIEW LANGUAGE: ' + (ctx.lang === 'en' ? 'English' : 'Arabic'), '');
  for (const q of chunk) {
    lines.push('ID: ' + q.id, 'TYPE: ' + q.kind + (q.competency ? ' (' + q.competency + ')' : ''), 'QUESTION: ' + q.question, 'ANSWER: """' + q.answer.slice(0, 2500) + '"""', '');
  }
  return lines.join('\n');
}

function withTimeout(p, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('ai_timeout')), ms); if (t.unref) t.unref(); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

// Returns { [id]: {score, verdict, strengths, improve, betterAnswer} } for the answers it could evaluate.
async function evaluateAnswers(questions, ctx, deps) {
  const chat = deps && deps.chat;
  if (!chat || !questions.length) return {};
  const chunks = [];
  for (let i = 0; i < questions.length; i += CHUNK) chunks.push(questions.slice(i, i + CHUNK));
  const out = {};
  const parts = await withTimeout(Promise.all(chunks.map((chunk) => chat(
    [{ role: 'system', content: systemPrompt(ctx.lang) }, { role: 'user', content: userPrompt(chunk, ctx) }],
    { max_tokens: 2200, temperature: 0.2 }
  ))), (deps && deps.timeoutMs) || TIMEOUT_MS);
  const ids = new Set(questions.map((q) => q.id));
  for (const part of parts) {
    for (const r of (part && Array.isArray(part.results) ? part.results : [])) {
      const score = _score(r && r.score);
      if (!r || !ids.has(r.id) || score == null) continue;
      const q = questions.find((x) => x.id === r.id);
      let better = _str(r.betterAnswer, 1400);
      if (better && inventsNumber(better, q.answer + ' ' + q.question)) better = '';
      out[r.id] = { score, verdict: _str(r.verdict, 200), strengths: _list(r.strengths, 2), improve: _list(r.improve, 2), betterAnswer: better };
    }
  }
  return out;
}

// Mutates an interview grade (from engine.gradeInterview) in place:
// adds res.ai per answer, takes the AI score as the answer's score, recomputes
// the summary, and stamps which evaluator produced the numbers.
async function applyToResult(session, answers, result, deps) {
  if (!result || result.kind !== 'interview' || !Array.isArray(result.items)) return result;
  const lang = session.lang === 'en' ? 'en' : 'ar';
  const questions = [];
  for (const it of result.items) {
    const answer = textOf((answers || {})[it.id]);
    if (wordCount(answer) < MIN_WORDS) continue;
    questions.push({
      id: it.id, kind: it.kind, answer,
      question: (it.question && (it.question[lang] || it.question.ar || it.question.en)) || '',
      competency: it.c ? ((iv.competencies[it.c] || {}).en || it.c) : '',
    });
  }
  let evaluator = 'short';
  let reason = (deps && deps.chat) ? '' : 'not_configured';
  if (!questions.length) {
    reason = 'no_answers';
  } else if (deps && deps.chat) {
    try {
      const byId = await evaluateAnswers(questions, { lang, role: (deps && deps.role) || session.family || '' }, deps);
      const got = questions.filter((q) => byId[q.id]).length;
      // Only call it an AI evaluation when every answered question was actually read.
      if (got === questions.length) {
        for (const it of result.items) {
          const ai = byId[it.id];
          if (!ai) continue;
          it.res.structureScore = it.res.score;
          it.res.score = ai.score;
          it.res.ai = ai;
        }
        evaluator = 'ai';
      } else {
        reason = 'incomplete';
      }
    } catch (e) {
      reason = 'failed';
      if (deps.onError) deps.onError(e);
    }
  }
  if (evaluator === 'ai') {
    const summary = S.summariseInterview(result.items.map((r) => ({ ...r, kind: r.kind === 'behavioural' || r.kind === 'situational' ? 'behavioural' : r.kind })));
    result.summary = summary;
    result.pct = summary.avg;
  }
  result.evaluator = evaluator;
  result.evaluatorLabel = LABEL[evaluator];
  result.evaluatorNote = NOTE[evaluator];
  if (evaluator === 'short') result.evaluatorReason = reason;
  return result;
}

// Default chat built from the server key; null when no key (=> short evaluation, labelled).
function chatFromEnv() {
  if (!process.env.OPENAI_API_KEY) return null;
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return async (messages, opts) => {
    const r = await openai.chat.completions.create({
      model: 'gpt-4o', messages, response_format: { type: 'json_object' },
      max_tokens: (opts && opts.max_tokens) || 2200, temperature: 0.2,
    });
    return JSON.parse(r.choices[0].message.content);
  };
}

module.exports = { applyToResult, evaluateAnswers, chatFromEnv, systemPrompt, userPrompt, inventsNumber, NOTE, LABEL, MIN_WORDS };
