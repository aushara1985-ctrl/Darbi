// ══════ Real CV diagnosis ══════════════════════════════════════════════════
// The diagnosis scores come from a GPT-4o reading of the person's own CV
// against the role they want, for ANY career family. When the AI is not
// available the result is a neutral evidence count, clearly marked as a
// rough estimate (source: 'heuristic'); it has no words that favour one
// field over another.
//
// Interview readiness is NOT guessed here: it can only be measured from real
// practice answers, so it is always null in this result.
//
// The OpenAI client is injected (deps.chat) so the logic is unit-testable.

function _clamp(n, lo, hi, dflt) {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return dflt;
  return Math.min(hi, Math.max(lo, x));
}
function _str(v, max) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, max || 300); }
function _list(v, n, max) {
  return (Array.isArray(v) ? v : []).map(x => _str(typeof x === 'string' ? x : (x && (x.title || x.text)) || '', max || 220)).filter(Boolean).slice(0, n || 5);
}
function toAsciiDigits(s) {
  return String(s == null ? '' : s).replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660));
}

const SENIORITY = ['fresh_grad', 'junior', 'mid', 'senior', 'executive'];

function systemPrompt() {
  return [
    'You are the CV analyst inside Darbi, an Arabic career app used in Saudi Arabia, the Gulf, Egypt, Jordan and Syria.',
    'Read the CV against the TARGET ROLE and score it honestly. The person may be in ANY field (accounting, nursing, engineering, sales, teaching, retail, software, hospitality, ...): judge the CV by the standards of THAT field and level, never by another field\'s vocabulary.',
    'Scores are 0-100 integers:',
    '- cvStrengthScore: how strong the CV itself is, whatever the role: clear structure, specific duties, results or evidence, dates and employers present, relevant education, no filler. A thin CV with no evidence scores below 40; a specific, evidenced CV scores above 70.',
    '- jobFitScore: how well THIS CV supports THIS target role today: relevant experience or education, required skills shown, right level. Wanting a senior role with junior evidence scores low. Hard requirements you cannot see are "unknown", not failures.',
    'Use only what is written in the CV. Never assume skills or experience that are not there. Quote nothing that is not in the CV.',
    'Write every text field in plain, gender-neutral Saudi Arabic (short sentences). Keep role titles and tools in their original language.',
    'Return JSON only:',
    '{',
    '  "cvStrengthScore": 0, "jobFitScore": 0,',
    '  "seniority": "fresh_grad|junior|mid|senior|executive",',
    '  "strengths": ["up to 3 real strengths found in the CV"],',
    '  "gaps": ["up to 4 concrete gaps between this CV and the target role"],',
    '  "whyNotGetting": "one or two sentences: the most likely reason this CV is not getting replies for this role",',
    '  "topFix": "the single most valuable change to make today",',
    '  "missingKeywords": ["up to 6 terms a recruiter for this role expects and the CV does not show"],',
    '  "nearestRoles": ["up to 4 real job titles this CV can win now, in the same field as the target role"]',
    '}',
  ].join('\n');
}

function userPrompt(input) {
  const lines = ['TARGET ROLE: ' + input.targetRole];
  if (input.country) lines.push('COUNTRY: ' + input.country);
  if (input.jobDescription) lines.push('JOB DESCRIPTION:\n"""\n' + input.jobDescription + '\n"""');
  lines.push('CV:\n"""\n' + input.cvText + '\n"""');
  return lines.join('\n\n');
}

function cleanInput(body) {
  const b = body || {};
  return {
    targetRole:     _str(b.targetRole || b.dreamRole, 160),
    cvText:         String(b.cvText || '').replace(/\r/g, '').trim().slice(0, 7000),
    jobDescription: String(b.jobDescription || '').trim().slice(0, 2000),
    country:        _str(b.country, 60),
  };
}

function normalizeAi(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const cv = _clamp(r.cvStrengthScore, 0, 100, null);
  const fit = _clamp(r.jobFitScore, 0, 100, null);
  if (cv == null || fit == null) return null;
  return {
    cvStrengthScore: cv,
    jobFitScore: fit,
    readinessScore: Math.round((cv + fit) / 2),
    interviewReadinessScore: null,
    seniority: SENIORITY.includes(r.seniority) ? r.seniority : 'unknown',
    strengths: _list(r.strengths, 3),
    gaps: _list(r.gaps, 4),
    whyNotGetting: _str(r.whyNotGetting, 400),
    topFix: _str(r.topFix, 300),
    missingKeywords: _list(r.missingKeywords, 6, 60),
    nearestRoles: _list(r.nearestRoles, 4, 80),
  };
}

// ─── neutral estimate (no AI) ──────────────────────────────────────────────
// Counts evidence that makes any CV stronger, in any field. No field words.
const ACTION_RE = /\b(led|managed|built|launched|grew|improved|delivered|designed|implemented|reduced|increased|trained|prepared|organi[sz]ed|analy[sz]ed|developed|supervised|coordinated)\b|قاد|قيادة|أدار|إدارة|ادارة|طوّر|طور|تطوير|أعد|إعداد|اعداد|نفّذ|نفذ|تنفيذ|حلّل|تحليل|نظّم|تنظيم|درّب|تدريب|أشرف|إشراف|صمّم|تصميم|رفع|خفّض|زيادة|تحسين/gi;
const EDU_RE = /bachelor|master|diploma|degree|university|college|بكالوريوس|ماجستير|دبلوم|جامعة|كلية|ثانوية/i;
const DATE_RE = /\b(19|20)\d{2}\b/g;

function heuristicAnalysis(input) {
  const cv = toAsciiDigits(input.cvText);
  const lower = cv.toLowerCase();
  const reasons = [];
  let strength = 20;
  const numbers = (cv.match(/\d+(?:\.\d+)?\s*%|\b\d{2,}\b/g) || []).length;
  const actions = (cv.match(ACTION_RE) || []).length;
  const dates = (cv.match(DATE_RE) || []).length;
  const lines = cv.split('\n').filter(l => l.trim().length > 8).length;
  if (numbers >= 3) { strength += 18; reasons.push('فيها أرقام ونتائج'); } else if (numbers >= 1) strength += 8;
  if (actions >= 5) { strength += 16; reasons.push('تصف أفعالاً ومسؤوليات واضحة'); } else if (actions >= 2) strength += 8;
  if (dates >= 2) { strength += 10; reasons.push('فيها تواريخ'); }
  if (EDU_RE.test(cv)) { strength += 8; reasons.push('التعليم مذكور'); }
  if (lines >= 12) strength += 10; else if (lines >= 6) strength += 5;
  if (/@/.test(cv) && /\d{7,}/.test(cv.replace(/[\s-]/g, ''))) strength += 5;
  strength = _clamp(strength, 10, 85, 30);

  // Fit: how many meaningful words of the target role appear in the CV.
  const words = input.targetRole.toLowerCase().split(/[\s,/&-]+/).filter(w => w.length >= 3);
  const hit = words.filter(w => lower.indexOf(w) !== -1).length;
  const share = words.length ? hit / words.length : 0;
  const fit = _clamp(strength * 0.5 + share * 40, 10, 80, 30);

  const gaps = [];
  if (numbers < 1) gaps.push('ما فيها أرقام أو نتائج قابلة للقياس');
  if (actions < 2) gaps.push('تصف مهام عامة بدون أفعال ونتائج واضحة');
  if (dates < 2) gaps.push('التواريخ ناقصة (متى بدأت ومتى انتهيت)');
  if (words.length && !hit) gaps.push('مسمى الوظيفة المستهدفة ما يظهر في السيرة');
  return {
    cvStrengthScore: strength,
    jobFitScore: fit,
    readinessScore: Math.round((strength + fit) / 2),
    interviewReadinessScore: null,
    seniority: 'unknown',
    strengths: reasons.slice(0, 3),
    gaps: gaps.slice(0, 4),
    whyNotGetting: '',
    topFix: gaps[0] ? 'ابدأ بهذي: ' + gaps[0] + '.' : '',
    missingKeywords: [],
    nearestRoles: [],
  };
}

const HEURISTIC_LABEL = 'تقدير مبدئي بدون ذكاء اصطناعي: عدّ بسيط للأدلة في سيرتك (أرقام، أفعال، تواريخ). التحليل الكامل غير متاح الحين.';

// deps.chat(messages, opts) -> parsed JSON (throws on failure); null = AI not configured.
async function analyzeCv(body, deps) {
  const input = cleanInput(body);
  if (!input.targetRole || input.cvText.length < 30) {
    return { success: false, error: 'missing_fields', message: 'نحتاج الوظيفة المستهدفة ونص سيرتك.' };
  }
  const chat = deps && deps.chat;
  if (chat) {
    try {
      const raw = await chat(
        [{ role: 'system', content: systemPrompt() }, { role: 'user', content: userPrompt(input) }],
        { max_tokens: 900, temperature: 0.2 }
      );
      const result = normalizeAi(raw);
      if (result) return { success: true, source: 'ai', result };
      throw new Error('bad_ai_shape');
    } catch (e) {
      if (deps.onError) deps.onError(e);
    }
  }
  return { success: true, source: 'heuristic', fallback: true, label: HEURISTIC_LABEL, result: heuristicAnalysis(input) };
}

// ─── Express route ─────────────────────────────────────────────────────────
// POST /api/darbi/analyze — public with tight limits (the diagnosis happens
// before signup); signed-in people get a higher allowance and the result is
// stored in `analyses`.
function register(app, deps) {
  const { rateLimit, getIP, optionalUser, safeAiErrorSummary, db } = deps;
  const onError = (e) => console.error('[analyze] AI error:', safeAiErrorSummary ? safeAiErrorSummary(e) : (e && e.message));

  function chatFactory() {
    if (!process.env.OPENAI_API_KEY) return null;
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return async (messages, opts) => {
      const r = await openai.chat.completions.create({
        model: 'gpt-4o', messages, response_format: { type: 'json_object' },
        max_tokens: (opts && opts.max_tokens) || 900, temperature: 0.2,
      });
      return JSON.parse(r.choices[0].message.content);
    };
  }

  app.post('/api/darbi/analyze', async (req, res) => {
    const user = optionalUser(req);
    const key = user ? ('analyze:u' + user.id) : ('analyze:ip' + getIP(req));
    if (!rateLimit(key, user ? 20 : 6, 3600_000)) {
      return res.status(429).json({ success: false, error: 'rate_limit', message: 'وصلت حد التحليل لهذي الساعة. جرّب بعد شوي.' });
    }
    try {
      const out = await analyzeCv(req.body, { chat: chatFactory(), onError });
      if (out.success === false) return res.status(400).json(Object.assign({ error: 'Missing fields' }, out));
      if (user && out.source === 'ai' && db) {
        const input = cleanInput(req.body);
        db.query(
          `INSERT INTO analyses (user_id, target_role, cv_text, readiness_score, result_json, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [user.id, input.targetRole, input.cvText.slice(0, 5000), out.result.readinessScore, JSON.stringify(out.result)]
        ).catch(e => console.error('[analyze] save failed:', e.message));
      }
      res.json(out);
    } catch (e) {
      onError(e);
      res.status(500).json({ success: false, error: 'analyze_failed', message: 'ما قدرنا نحلل السيرة الحين. حاول بعد شوي.' });
    }
  });
}

module.exports = { analyzeCv, heuristicAnalysis, normalizeAi, cleanInput, systemPrompt, userPrompt, register, HEURISTIC_LABEL };
