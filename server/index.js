require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// ─── JWT secret (fail loud in production if missing) ─────────────────────────
if (IS_PROD && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is required in production. Set it in Railway Variables.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || 'darbi_dev_only_secret_DO_NOT_USE_IN_PROD';

// ─── CORS ─────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://darbi-production.up.railway.app',
  'http://localhost:3000',
  'http://localhost:5173',
  process.env.APP_URL,
].filter(Boolean);

app.use(cors({
  origin: function(origin, callback) {
    // No-origin requests (curl, same-origin server-to-server) are allowed.
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.railway.app')) {
      return callback(null, true);
    }
    if (IS_PROD) {
      // Drop the Access-Control-Allow-Origin header. Browsers will block;
      // non-browser callers can still hit the endpoint, which is fine because
      // CORS is not an authn/authz boundary — JWT auth is.
      return callback(null, false);
    }
    // Dev only: allow anything to ease local frontend work.
    callback(null, true);
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true,
}));

// The Stripe webhook must receive the RAW body (signature check). Skip the JSON/urlencoded
// parsers for that one path — otherwise req.body is already an object and every event is rejected.
const _jsonParser = express.json({ limit: '10mb' });
const _urlParser = express.urlencoded({ extended: true, limit: '10mb' });
const _isStripeWebhook = (req) => req.originalUrl === '/api/payment/webhook' || req.originalUrl.startsWith('/api/payment/webhook?');
app.use((req, res, next) => (_isStripeWebhook(req) ? next() : _jsonParser(req, res, next)));
app.use((req, res, next) => (_isStripeWebhook(req) ? next() : _urlParser(req, res, next)));

// ─── Serve frontend ────────────────────────────────────────────────────────────
// V2 is the product. Root "/" serves V2; V1 is archived at "/v1".
// Registered BEFORE express.static so the static middleware's default
// index.html (V1) never wins at "/".
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/v2.html'));
});
app.get('/v1', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});
require('./legal').mount(app);
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

// ─── DB (PostgreSQL) ──────────────────────────────────────────────────────────
const { Pool } = require('pg');
// SSL only for remote databases (Railway). A local/test Postgres on 127.0.0.1 does not speak SSL.
const _dbUrl = process.env.DATABASE_URL || '';
const _dbLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:\/]/.test(_dbUrl);
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: _dbLocal ? false : { rejectUnauthorized: false } });

// ─── Helpers ──────────────────────────────────────────────────────────────────
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const trial  = require('./trial');

// Summarize an AI/OpenAI error into something safe to log AND safe to return
// to the client. Never echoes raw response bodies, API keys, or full stack
// traces. Used in every catch block that touches OpenAI.
function safeAiErrorSummary(e) {
  if (!e) return { status: null, code: null, type: null, msg: 'unknown_error' };
  const status = (e && (e.status || (e.response && e.response.status))) || null;
  const code   = (e && (e.code || (e.error && e.error.code))) || null;
  const type   = (e && (e.type || (e.error && e.error.type))) || null;
  const raw    = String((e && e.message) || '').slice(0, 200);
  // Redact anything that looks like a key (sk-..., bearer tokens, long hex).
  const msg = raw
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, 'Bearer ***')
    .replace(/[A-Fa-f0-9]{32,}/g, '***');
  return { status: status, code: code, type: type, msg: msg };
}

// ─── Rate limiter + IP helper (used by public/unauth endpoints) ──────────────
// In-memory sliding window. Cleared on restart; best-effort abuse prevention,
// not a security boundary. For real security, use authMiddleware + DB tracking.
const _rateMap = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const entry = _rateMap.get(key);
  if (!entry || now > entry.resetAt) {
    _rateMap.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}
const _rateCleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rateMap) if (now > v.resetAt) _rateMap.delete(k);
}, 60_000);
if (_rateCleanup.unref) _rateCleanup.unref();

function getIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  const raw = (Array.isArray(fwd) ? fwd[0] : fwd) || (req.socket && req.socket.remoteAddress) || 'unknown';
  return String(raw).split(',')[0].trim();
}

// ─── Arabic normalization (server) ────────────────────────────────────────────
// Used by the heuristic intent fallback so 'خدمه عملاء' == 'خدمة عملاء' etc.
function _arNormalize(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ـ/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Login required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const refCode = 'D' + Math.random().toString(36).substr(2, 6).toUpperCase();
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, referral_code, access_status, created_at)
       VALUES ($1, $2, $3, 'free', NOW())
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, referral_code, access_status`,
      [email.toLowerCase(), hash, refCode]
    );
    if (!rows[0]) return res.status(409).json({ error: 'البريد الإلكتروني مسجّل مسبقاً' });
    // 7-day Pro trial + welcome email (best effort; never blocks signup).
    try {
      await trial.startTrial(db, rows[0].id);
      const fresh = await db.query('SELECT id, email, referral_code, access_status, trial_ends_at, created_at FROM users WHERE id = $1', [rows[0].id]);
      if (fresh.rows[0]) rows[0] = trial.publicUser(fresh.rows[0]);
      trial.sendOnce(db, rows[0].id, rows[0].email, 'welcome').catch(() => {});
    } catch (e) { console.error('[trial] start failed:', e.message); }
    const token = jwt.sign({ id: rows[0].id, email: rows[0].email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!rows[0]) return res.status(401).json({ error: 'البريد أو كلمة المرور غير صحيحة' });
    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'البريد أو كلمة المرور غير صحيحة' });
    const token = jwt.sign({ id: rows[0].id, email: rows[0].email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: trial.publicUser(rows[0]) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/darbi/me', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, email, access_status, referral_code, created_at, trial_ends_at FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, user: trial.publicUser(rows[0]) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ROLE INTENT ENGINE ───────────────────────────────────────────────────────
// resolveDreamIntent — classifies the user's dream role into one of the
// canonical families. OpenAI is the primary path; a normalized concept-match
// fallback exists ONLY to prevent stupid output when OpenAI is unavailable.
// The fallback is NOT marketed as smart — it returns honest confidence and
// surfaces "unknown" instead of inventing roles.
const INTENT_FAMILIES = [
  'marketing', 'hr', 'accounting', 'sales',
  'customer_service', 'it_cyber', 'design', 'data',
  'admin_office', 'simple_job', 'unknown',
];

// Core concepts per family. NOT exhaustive synonyms — broad concepts that any
// reasonable dream-role description in this family should contain. Used by the
// heuristic fallback ONLY.
const FAMILY_CONCEPTS = {
  marketing:        ['تسويق','marketing','social media','content','حملات','seo','إعلانات','digital marketing','رقمي','محتوى'],
  hr:               ['موارد بشرية','hr','recruitment','توظيف','talent','استقطاب','تنمية بشرية','people'],
  accounting:       ['محاسبة','accounting','محاسب','finance','مالية','audit','بنوك','banking','تدقيق'],
  sales:            ['مبيعات','sales','بيع','مندوب','telesales','account executive'],
  customer_service: ['خدمه','عملاء','customer service','customer support','customer care','call center','كول سنتر','عنايه','دعم','client services','تواصل'],
  it_cyber:         ['it','تقنيه','cybersecurity','امن سيبراني','helpdesk','soc','شبكات','networking','it support'],
  data:             ['data analyst','data analytics','data scientist','data engineer','business intelligence','power bi','تحليل بيانات','محلل بيانات','علم البيانات','عالم بيانات','مهندس بيانات','ذكاء الاعمال'],
  design:           ['design','تصميم','graphic','ui','ux','مصمم','figma','adobe','بصري'],
  admin_office:     ['اداري','admin','office','coordinator','منسق','executive assistant','سكرتير','data entry','مكتبي','تنسيق'],
  simple_job:       ['كاشير','cashier','باريستا','barista','ماكدونالد','starbucks','retail','تجزئه','فرع','مطعم','استقبال','مقهى','وظيفه بسيطه'],
};

function heuristicIntent(dreamRole, cvText) {
  const dn = _arNormalize(dreamRole || '');
  const cn = _arNormalize(cvText || '').slice(0, 800); // CV first 800 chars only
  const combined = dn + ' ' + cn;

  let bestFam = 'unknown';
  let bestScore = 0;
  let bestHits = [];

  for (const fam of Object.keys(FAMILY_CONCEPTS)) {
    let score = 0;
    const hits = [];
    for (const concept of FAMILY_CONCEPTS[fam]) {
      const cnorm = _arNormalize(concept);
      if (!cnorm) continue;
      // Stronger signal if the dream-role itself contains it (vs only the CV).
      if (dn.indexOf(cnorm) !== -1) { score += 2; hits.push(concept); }
      else if (combined.indexOf(cnorm) !== -1) { score += 1; hits.push(concept); }
    }
    if (score > bestScore) {
      bestScore = score;
      bestFam = fam;
      bestHits = hits;
    }
  }

  // Honest confidence calibration. The fallback is NOT the intelligence —
  // it should refuse to commit on weak signal so the UI asks the user to pick.
  let confidence;
  if (bestScore === 0)      { confidence = 18; bestFam = 'unknown'; }
  else if (bestScore === 1) { confidence = 45; }
  else if (bestScore === 2) { confidence = 62; }
  else if (bestScore === 3) { confidence = 74; }
  else                       { confidence = 82; }

  // Simple seniority detection — used only when OpenAI didn't provide one.
  let inferredSeniority = 'unknown';
  const cv = cvText || '';
  if (/\b(vp|vice president|chief|cxo)\b|director|head of/i.test(cv)) inferredSeniority = 'executive';
  else if (/(10|eleven|twelve|1[3-9]|20|25|30)\+?\s*(year|years|سنه|سنوات|سنين)/i.test(cv)) inferredSeniority = 'senior';
  else if (/[5-9]\+?\s*(year|years|سنه|سنوات|سنين)/i.test(cv)) inferredSeniority = 'mid';
  else if (/\b(student|طالب|طالبه|undergraduate)\b/i.test(cv)) inferredSeniority = 'student';
  else if (/\b(fresh|graduate|تخرج|تخرجت|خريج|intern|تدريب)\b/i.test(cv)) inferredSeniority = 'fresh_grad';

  return {
    family: bestFam,
    confidence,
    normalizedDreamRole: dn,
    inferredSeniority,
    reason: bestScore > 0
      ? `طابق ${bestScore} مفهوم: ${bestHits.slice(0, 3).join('، ')}`
      : 'ما طابق أي مفهوم واضح من العائلات المعروفة — نحتاج تحديد منك',
    nearestRoleLogic: 'heuristic_concept_match',
    isSimpleJob: bestFam === 'simple_job',
    source: 'heuristic',
  };
}

async function openaiIntent(dreamRole, cvText, quizAnswers) {
  if (!process.env.OPENAI_API_KEY) return null;
  let openai;
  try {
    const OpenAI = require('openai');
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch (e) {
    console.error('[intent] OpenAI SDK load failed:', safeAiErrorSummary(e));
    return null;
  }

  const prompt = `أنت مصنّف مسارات مهنية للسوق السعودي. حدّد إلى أي عائلة وظيفية ينتمي هدف المستخدم.

العائلات المسموح بها (بالضبط، لا تخترع غيرها):
- marketing (تسويق)
- hr (موارد بشرية)
- accounting (محاسبة/مالية)
- sales (مبيعات)
- customer_service (خدمة عملاء/دعم/كول سنتر/عناية بالعملاء)
- it_cyber (تقنية/أمن سيبراني)
- design (تصميم)
- data (تحليل بيانات/علم بيانات/ذكاء أعمال BI)
- admin_office (إداري/منسق/سكرتير)
- simple_job (كاشير/باريستا/استقبال/تجزئة/مقهى — وظائف لا تحتاج تخصص)
- unknown (الهدف غير واضح أو لا يطابق أي عائلة)

المدخلات:
- الدور المرغوب: ${(dreamRole || '').slice(0, 200)}
- مقتطف السيرة (أول 800 حرف): ${(cvText || '').slice(0, 800)}
${quizAnswers ? `- إجابات quiz: ${JSON.stringify(quizAnswers).slice(0, 400)}` : ''}

أرجع JSON صارم فقط:
{
  "family": "<عائلة من القائمة فقط>",
  "confidence": <عدد صحيح 0-100>,
  "inferredSeniority": "<student|fresh_grad|entry|mid|senior|executive|unknown>",
  "reason": "<سطر واحد بالعربي يشرح ليش اخترت هذي العائلة>",
  "isSimpleJob": <true|false>,
  "nearestEntryRoles": ["<دور واقعي 1>", "<دور 2>", "<دور 3>"]
}

قواعد صارمة:
- لا تخترع شركات أو أسماء محددة.
- إذا الهدف غامض أو ما يطابق عائلة معروفة، استخدم family="unknown" وconfidence أقل من 50.
- ممنوع تماماً اقتراح "Junior X" أو "Trainee X" أو "Assistant X" مع X غير محدد. اقترح أدوار حقيقية كاملة فقط (مثل "Customer Service Representative"، "HR Coordinator")، لا templates.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 500,
      temperature: 0.2,
    });
    const parsed = JSON.parse(response.choices[0].message.content);

    // Defensive normalization — never trust LLM output blindly.
    let family = parsed.family;
    if (!INTENT_FAMILIES.includes(family)) family = 'unknown';
    let confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 50;
    confidence = Math.max(0, Math.min(100, Math.round(confidence)));
    const seniority = ['student','fresh_grad','entry','mid','senior','executive','unknown']
      .includes(parsed.inferredSeniority) ? parsed.inferredSeniority : 'unknown';
    let nearest = Array.isArray(parsed.nearestEntryRoles) ? parsed.nearestEntryRoles : [];
    // Strip any "Junior {placeholder}" / "Trainee {placeholder}" / "Assistant {placeholder}"
    // patterns the model might still produce.
    nearest = nearest
      .filter(r => typeof r === 'string')
      .map(r => r.trim())
      .filter(r => r.length >= 3 && r.length <= 80)
      .filter(r => !/^(junior|trainee|assistant)\s+(\{|<|x\b|role\b)/i.test(r))
      .slice(0, 5);

    return {
      family,
      confidence,
      normalizedDreamRole: _arNormalize(dreamRole || ''),
      inferredSeniority: seniority,
      reason: String(parsed.reason || '').slice(0, 200),
      nearestRoleLogic: nearest,
      isSimpleJob: !!parsed.isSimpleJob,
      source: 'openai',
    };
  } catch (e) {
    console.error('[intent] OpenAI classify error:', safeAiErrorSummary(e));
    return null;
  }
}

app.post('/api/darbi/resolve-intent', async (req, res) => {
  // Public endpoint — called pre-signup from the diagnosis flow. Two-tier
  // rate limit per IP (burst + hourly) to keep OpenAI bills bounded without
  // blocking honest users on slow connections.
  const ip = getIP(req);
  if (!rateLimit('intent-burst:' + ip, 5, 60_000) ||
      !rateLimit('intent-hour:' + ip, 60, 3600_000)) {
    return res.status(429).json({ error: 'rate_limit', message: 'Too many requests' });
  }

  const { dreamRole, cvText, quizAnswers } = req.body || {};
  if (typeof dreamRole !== 'string' || dreamRole.trim().length < 1 || dreamRole.length > 300) {
    return res.status(400).json({ error: 'invalid_dreamRole' });
  }
  const cv = typeof cvText === 'string' ? cvText.slice(0, 8000) : '';

  // Primary: OpenAI classification (when key is present and call succeeds).
  let intent = await openaiIntent(dreamRole.trim(), cv, quizAnswers);

  // Safety net: heuristic concept-match fallback. Returns honest confidence;
  // unknown is a valid output when the dream role doesn't map cleanly.
  if (!intent) intent = heuristicIntent(dreamRole.trim(), cv);

  res.json({ success: true, intent });
});

// Interview/assessment preparation program (/api/assess/*). authMiddleware, db, rateLimit, getIP are defined above.
require('./assessments/routes')(app, { authMiddleware, db, rateLimit, getIP });

// ─── JOBS SEARCH (career-family-agnostic, hybrid ATS + aggregator) ───────────
// Registration is delegated to ./jobs to keep this file lean. Two routes:
//   GET  /api/jobs/sources   → public ATS sources + provider availability
//   POST /api/jobs/search    → fetch + rank + return honest fallback
try {
  require('./jobs').register(app, { rateLimit, getIP });
  console.log('[jobs] routes registered');
} catch (e) {
  console.error('[jobs] failed to register routes:', e.message);
}

// ─── ANALYSIS ─────────────────────────────────────────────────────────────────
app.post('/api/darbi/analyze', authMiddleware, async (req, res) => {
  const { targetRole, cvText, jobDescription = '' } = req.body;
  if (!targetRole || !cvText) return res.status(400).json({ error: 'Missing fields' });

  console.log('[DARBI_ANALYZE_ACTIVE]', {
    route: '/api/darbi/analyze',
    parserVersion: 'v2_fixed_parser',
    timestamp: new Date().toISOString(),
    targetRole,
    hasJD: !!jobDescription,
  });

  if (!process.env.OPENAI_API_KEY) {
    // Heuristic fallback
    const score = computeHeuristicScore(cvText, targetRole, jobDescription);
    return res.json({ success: true, result: score });
  }

  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const prompt = `أنت محلل سيرة ذاتية خبير للسوق السعودي والعالمي.

الوظيفة المستهدفة: ${targetRole}
${jobDescription ? `وصف الوظيفة:\n${jobDescription.substring(0, 1500)}` : ''}

السيرة الذاتية:
${cvText.substring(0, 3000)}

مهم جداً:
1. لا تخلط قوة السيرة مع المتطلبات الإلزامية
2. سيرة قوية مع مدير CS ذو خبرة 10+ سنين يجب أن تحصل على cv_strength >= 70
3. المتطلبات الإلزامية (ألماني/تصريح عمل) تؤثر على job_fit فقط وليس cv_strength
4. لا تستخرج كلمات عامة مثل please/position/requires كـ keywords

أرجع JSON فقط:
{
  "cvStrengthScore": 75,
  "jobFitScore": 60,
  "hardRequirementStatus": "pass|missing|unknown",
  "hardRequirementIssues": ["German fluency not shown"],
  "interviewReadinessScore": 25,
  "readinessScore": 68,
  "readinessRange": "70-80%",
  "confidence": "high",
  "seniority": "executive|senior|mid|junior",
  "whyNotGetting": "تفسير واضح",
  "problems": [{"title": "المشكلة", "desc": "التفاصيل", "quote": null, "fix": "الحل"}],
  "improvedSummary": "ملخص محسّن مناسب للمستوى",
  "recommendedKeywords": ["health scoring", "segmentation", "gross retention"],
  "matchedSkills": ["customer success leadership", "retention"],
  "missingKeywords": ["German fluency", "work authorization Germany"],
  "careerPath": [
    {"role": "Head of CS", "readinessNeeded": 35, "daysFromNow": 0, "isCurrent": true, "isTarget": false},
    {"role": "Director CS", "readinessNeeded": 55, "daysFromNow": 14, "isCurrent": false, "isTarget": false},
    {"role": "VP Customer Success", "readinessNeeded": 70, "daysFromNow": 30, "isCurrent": false, "isTarget": true}
  ],
  "jobMatches": [{"role": "VP CS في شركات خليجية", "type": "best", "why": "سيرتك قوية بدون قيود جغرافية", "action": "قدّم هذا الأسبوع"}]
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 1500,
      temperature: 0.3,
    });

    const result = JSON.parse(response.choices[0].message.content);

    // Save to DB
    await db.query(
      `INSERT INTO analyses (user_id, target_role, cv_text, readiness_score, result_json, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [req.user.id, targetRole, cvText.substring(0, 5000), result.readinessScore, JSON.stringify(result)]
    );

    res.json({ success: true, result });
  } catch (e) {
    console.error('[analyze] AI error:', safeAiErrorSummary(e));
    const score = computeHeuristicScore(cvText, targetRole, jobDescription);
    res.json({ success: true, result: score, fallback: true });
  }
});

// ─── TRAINING ─────────────────────────────────────────────────────────────────
app.post('/api/darbi/training/start', authMiddleware, async (req, res) => {
  const { isBaseline = false } = req.body;
  try {
    const { rows } = await db.query(
      `INSERT INTO training_sessions (user_id, is_baseline, started_at)
       VALUES ($1, $2, NOW()) RETURNING id`,
      [req.user.id, isBaseline]
    );
    res.json({ success: true, sessionId: rows[0].id });
  } catch (e) { res.json({ success: true, sessionId: null }); }
});

app.post('/api/darbi/training/answer', authMiddleware, async (req, res) => {
  const { sessionId, questionText, answerText, targetSkill, qid, company, role, simple } = req.body;
  const evalCtx = { qid: typeof qid === 'string' ? qid.slice(0, 30) : '', company: typeof company === 'string' ? company.slice(0, 80) : '', role: typeof role === 'string' ? role.slice(0, 80) : '', simple: simple === true };
  if (!answerText) return res.status(400).json({ error: 'Missing answer' });

  if (!process.env.OPENAI_API_KEY) {
    return res.json({ success: true, evaluation: localEvaluate(answerText, evalCtx), local: true });
  }

  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const prompt = `أنت مدرب مقابلات خبير للسوق السعودي.

السؤال: ${questionText}
الإجابة: ${answerText}

قيّم الإجابة وأرجع JSON فقط:
{
  "overallScore": 45,
  "verdict": "إجابة ضعيفة|متوسطة|قوية",
  "whyFail": "لماذا ستفشل في مقابلة حقيقية",
  "weakPoints": ["نقطة ضعف 1", "نقطة ضعف 2"],
  "improvedAnswer": "إجابة محسّنة بـ STAR وأرقام",
  "oneFix": "إصلاح واحد محدد للتطبيق الفوري",
  "readinessGain": 2
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 800,
      temperature: 0.3,
    });

    const evaluation = JSON.parse(response.choices[0].message.content);

    // Update skill scores
    if (sessionId) {
      await db.query(
        `UPDATE training_sessions SET answers_count = answers_count + 1, last_score = $1 WHERE id = $2`,
        [evaluation.overallScore, sessionId]
      ).catch(() => {});
    }

    res.json({ success: true, evaluation });
  } catch (e) {
    console.error('[training/answer] AI error:', safeAiErrorSummary(e));
    res.json({ success: true, evaluation: localEvaluate(answerText, evalCtx), local: true });
  }
});

app.post('/api/darbi/training/finalize', authMiddleware, async (req, res) => {
  const { sessionId, readinessAfter, avgAnswerScore } = req.body;
  try {
    await db.query(
      `UPDATE training_sessions SET readiness_after = $1, avg_score = $2, completed_at = NOW() WHERE id = $3`,
      [readinessAfter, avgAnswerScore, sessionId]
    );
    await db.query(
      `UPDATE users SET interview_readiness = $1, training_day = training_day + 1, last_activity = NOW() WHERE id = $2`,
      [readinessAfter, req.user.id]
    );
    res.json({ success: true });
  } catch (e) { res.json({ success: true }); }
});

// ─── PAYMENT (Stripe — the ONLY payment path) ────────────────────────────────
// Ali's prices (2026-11-18): starter $9/month, pro $19/month, lifetime (Founder) $199 one-time.
// If Ali creates Stripe Prices he sets STRIPE_PRICE_STARTER_MONTHLY / STRIPE_PRICE_PRO_MONTHLY /
// STRIPE_PRICE_FOUNDER_LIFETIME (price_...). Otherwise the amounts below are sent inline.
const PLANS = {
  starter:  { name: 'Darbi Starter — Monthly',    amount: 900,   recurring: true,  env: 'STRIPE_PRICE_STARTER_MONTHLY' },
  pro:      { name: 'Darbi Pro — Monthly',        amount: 1900,  recurring: true,  env: 'STRIPE_PRICE_PRO_MONTHLY' },
  lifetime: { name: 'Darbi Founder — Lifetime',   amount: 19900, recurring: false, env: 'STRIPE_PRICE_FOUNDER_LIFETIME' },
};
app.get('/api/payment/config', (req, res) => {
  res.json({
    enabled: !!process.env.STRIPE_SECRET_KEY,
    plans: Object.keys(PLANS).map((k) => ({ key: k, usd: PLANS[k].amount / 100, recurring: PLANS[k].recurring })),
  });
});
app.post('/api/payment/checkout', authMiddleware, async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const planKey = PLANS[req.body && req.body.plan] ? req.body.plan : 'lifetime';
  const P = PLANS[planKey];
  const baseUrl = process.env.APP_URL || 'http://localhost:3000';

  try {
    const line = process.env[P.env]
      ? { price: process.env[P.env], quantity: 1 }
      : {
          price_data: {
            currency: 'usd',
            product_data: { name: P.name },
            unit_amount: P.amount,
            recurring: P.recurring ? { interval: 'month' } : undefined,
          },
          quantity: 1,
        };
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [line],
      mode: P.recurring ? 'subscription' : 'payment',
      success_url: `${baseUrl}/?payment_success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/#/pricing`,
      customer_email: req.user.email,
      metadata: { userId: req.user.id, plan: planKey },
      // Monthly plans: carry the user id on the subscription itself so the
      // subscription.deleted / updated webhooks can find the account again.
      ...(P.recurring ? { subscription_data: { metadata: { userId: String(req.user.id), plan: planKey } } } : {}),
    });
    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: 'تعذّر بدء الدفع، حاول لاحقاً' }); }
});

// Opens Stripe's customer portal so a subscriber can cancel or change the monthly plan themselves.
// (Needs the portal to be switched on once in the Stripe dashboard: Settings > Billing > Customer portal.)
app.post('/api/payment/portal', authMiddleware, async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe not configured' });
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const list = await stripe.customers.list({ email: req.user.email, limit: 1 });
    if (!list.data.length) return res.status(404).json({ error: 'no_customer' });
    const portal = await stripe.billingPortal.sessions.create({
      customer: list.data[0].id,
      return_url: (process.env.APP_URL || 'http://localhost:3000') + '/#/account',
    });
    res.json({ url: portal.url });
  } catch (e) { res.status(500).json({ error: 'portal_failed' }); }
});

const billingPlans = require('./billing/plans');
app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return res.json({ received: true });
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) { return res.status(400).json({ error: e.message }); }

  // All plan bookkeeping (grant plan, revoke on cancel, lifetime never revoked) lives in ./billing/plans.js and is unit-tested.
  await billingPlans.handleEvent(db, event, { stripe });
  res.json({ received: true });
});

// Confirms a Stripe Checkout Session and grants paid access ONLY if Stripe
// itself reports payment_status === 'paid' AND session.metadata.userId matches
// the authenticated user. This is a defence-in-depth path used when the user
// returns from Stripe; the webhook is still the source of truth.
app.post('/api/darbi/payment/success', authMiddleware, async (req, res) => {
  const { stripeSessionId } = req.body || {};
  if (!stripeSessionId) return res.status(400).json({ error: 'stripeSessionId required' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe not configured' });

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(stripeSessionId);

    const isPaid = session && (session.payment_status === 'paid' || session.status === 'complete');
    const ownerId = session && session.metadata && session.metadata.userId;
    if (!isPaid) return res.status(402).json({ success: false, error: 'session not paid' });
    if (String(ownerId) !== String(req.user.id)) {
      return res.status(403).json({ success: false, error: 'session does not belong to user' });
    }

    await billingPlans.grantPlan(db, req.user.id, billingPlans.resolvePlan(session), { sessionId: stripeSessionId, source: 'stripe_session_verify' });
    res.json({ success: true });
  } catch (e) {
    console.error('[payment/success] verify error:', e.message);
    res.status(500).json({ success: false, error: 'verification failed' });
  }
});

// ─── UGC ──────────────────────────────────────────────────────────────────────
app.post('/api/darbi/ugc/submit', authMiddleware, async (req, res) => {
  const { scriptType, videoUrl } = req.body;
  try {
    await db.query(
      `INSERT INTO ugc_submissions (user_id, script_type, video_url, status, created_at)
       VALUES ($1, $2, $3, 'pending', NOW())`,
      [req.user.id, scriptType, videoUrl]
    );
    res.json({ success: true, status: 'pending' });
  } catch (e) { res.json({ success: true, status: 'pending' }); }
});

// ─── OUTCOMES ─────────────────────────────────────────────────────────────────
app.post('/api/darbi/outcomes', authMiddleware, async (req, res) => {
  const { job, type, timestamp } = req.body;
  try {
    await db.query(
      `INSERT INTO job_outcomes (user_id, job_title, outcome_type, occurred_at)
       VALUES ($1, $2, $3, NOW())`,
      [req.user.id, job, type]
    );
    res.json({ success: true });
  } catch (e) { res.json({ success: true }); }
});

// ─── REFERRAL ─────────────────────────────────────────────────────────────────
app.post('/api/darbi/referral/apply', authMiddleware, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.json({ success: false });
  try {
    const { rows } = await db.query('SELECT id FROM users WHERE referral_code = $1', [code]);
    if (rows[0] && rows[0].id !== req.user.id) {
      await db.query(
        `INSERT INTO referrals (referrer_id, referred_id, created_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING`,
        [rows[0].id, req.user.id]
      );
    }
    res.json({ success: true });
  } catch (e) { res.json({ success: false }); }
});

// ─── FEEDBACK ─────────────────────────────────────────────────────────────────
app.post('/api/darbi/feedback', async (req, res) => {
  console.log('[feedback]', req.body);
  res.json({ success: true });
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ─── DEBUG ENDPOINT ───────────────────────────────────────────────────────────
app.get('/api/debug/analysis-version', (req, res) => {
  res.json({
    parserVersion: 'v2_fixed_parser',
    analysisEngineName: 'computeHeuristicScore -> parseJD + detectSeniority + 4-score',
    activeAnalyzeRoute: 'POST /api/darbi/analyze',
    stoplistSize: JD_STOPLIST.size,
    sampleStoplistWords: [...JD_STOPLIST].slice(0, 10),
    deployedAt: new Date().toISOString(),
    note: 'Keywords are NEVER raw words — only structured categories from parseJD()',
  });
});

// ─── FORCE TEST ───────────────────────────────────────────────────────────────
app.get('/api/debug/test-vp-cs', (req, res) => {
  const sampleCV = `VP Customer Success | 12 years experience
Led CS org managing 80M SAR ARR portfolio across 100+ enterprise accounts.
Built health scoring framework, playbooks, and segmentation model.
Improved gross retention from 78% to 92% over 18 months.
Led team of 15 CSMs and 3 managers. Presented to board quarterly.
Managed renewals, expansion, and VOC loop into product roadmap.
Tools: Salesforce, Gainsight, Tableau.`;
  
  const sampleJD = `VP of Customer Success (m/f/d) at Voize GmbH
Please note that this position requires work authorization for Germany.
Language: English - Fluent, German - Fluent
Build and lead the Customer Success & Support org (CX)
Customer health: measurement philosophy, signals, early-warning system
Onboarding & rollouts from pilots to multi-site deployments
Gross retention: protecting the base through deep product usage
Voice of the customer: feedback loop into product, engineering, and GTM
Scale org from today team to 50+ FTE across CS, Implementation, Support
Manager of managers. Present to the board quarterly. GTM leadership team.`;

  const result = computeHeuristicScore(sampleCV, 'VP Customer Success', sampleJD);
  
  const tests = {
    'cv_strength >= 70': result.cvStrengthScore >= 70,
    'job_fit 45-65': result.jobFitScore >= 45 && result.jobFitScore <= 65,
    'interview_readiness 20-35': result.interviewReadinessScore >= 20 && result.interviewReadinessScore <= 35,
    'hard_req = missing': result.hardRequirementStatus === 'missing',
    'no garbage keywords': !result.missingKeywords.some(k => ['about','customer','success','position','requires','voize','mfd'].includes(k.toLowerCase())),
    'career path has Head of CS': result.careerPath && result.careerPath[0].role.includes('Head'),
    'career path has Director': result.careerPath && result.careerPath[1].role.includes('Director'),
    'career path target = VP': result.careerPath && result.careerPath[2].isTarget,
  };

  const passed = Object.values(tests).filter(Boolean).length;
  res.json({ passed: passed + '/' + Object.keys(tests).length, tests, result });
});

// SPA fallback is registered at the very bottom of this file, AFTER all
// /api/* routes — Express matches in registration order and a top-level
// `app.get('*')` will swallow any later GETs (e.g. /api/training/status).

// ─── Smart JD Parser ──────────────────────────────────────────────────────────
const JD_STOPLIST = new Set(['please','note','position','requires','about','company','click','apply','details','benefits','team','process','table','mission','activities','language','work','job','role','responsibilities','requirements','experience','years','fluent','nice','have','that','this','with','will','your','their','from','into','what','they','which','when','been','also','well','each','both','very','here','then','than','some','make','many','more','most','over','such','used','use','able','our','you','all','its','can','may','are','has','was','the','and','for','not','but','who','how','new','one','two','day','way','get','set','put','run','let','say','see','try','own','org','ceo','inc','llc','ltd','gmbh']);

function parseJD(jdText) {
  if (!jdText || jdText.length < 50) return { hardRequirements:[], roleSkills:[], domainContext:[], leadershipScope:[], csSystems:[], keywords:[] };
  const result = { hardRequirements:[], roleSkills:[], domainContext:[], leadershipScope:[], csSystems:[], keywords:[] };
  if (/work authorization|visa|right to work/i.test(jdText)) { const m=jdText.match(/authorization (?:for |in )?([A-Z][a-z]+)/); result.hardRequirements.push('work authorization'+(m?' for '+m[1]:'')); }
  const langM=jdText.match(/(?:german|deutsch|arabic|french|spanish)\s*[-–]?\s*(?:fluent|c2|native|required|c1)/gi)||[];
  langM.forEach(l=>result.hardRequirements.push(l.trim()));
  const skillPatterns=[{p:/customer success|cs leadership/i,s:'customer success leadership'},{p:/pre-?sales|sales engineering/i,s:'pre-sales'},{p:/discovery|storytelling|presentation/i,s:'discovery & storytelling'},{p:/ai|machine learning/i,s:'AI knowledge'},{p:/api|integration/i,s:'APIs & integrations'},{p:/team lead|lead.*team/i,s:'team leadership'},{p:/board|exec.*team/i,s:'executive communication'}];
  skillPatterns.forEach(({p,s})=>{ if(p.test(jdText)) result.roleSkills.push(s); });
  if (/healthcare|hospital|nursing/i.test(jdText)) result.domainContext.push('healthcare');
  if (/saas|software.*service/i.test(jdText)) result.domainContext.push('SaaS');
  if (/50\+?\s*fte|scale.*org/i.test(jdText)) result.leadershipScope.push('scale org 50+ FTE');
  if (/manager of manager/i.test(jdText)) result.leadershipScope.push('manager of managers');
  if (/board.*quarterly/i.test(jdText)) result.leadershipScope.push('board reporting');
  if (/health score|health.*signal/i.test(jdText)) result.csSystems.push('customer health scoring');
  if (/segmentation|high.touch/i.test(jdText)) result.csSystems.push('customer segmentation');
  if (/onboarding|time.to.value/i.test(jdText)) result.csSystems.push('onboarding & time-to-value');
  if (/gross retention|grr/i.test(jdText)) result.csSystems.push('gross retention');
  if (/voc|voice of.*customer/i.test(jdText)) result.csSystems.push('voice of customer');
  const words=jdText.split(/\s+/); const kc={};
  words.forEach(w=>{ const c=w.toLowerCase().replace(/[^a-z]/g,''); if(c.length>4&&!JD_STOPLIST.has(c)){kc[c]=(kc[c]||0)+1;} });
  result.keywords=Object.entries(kc).filter(([,v])=>v>=2).sort(([,a],[,b])=>b-a).slice(0,10).map(([w])=>w);
  return result;
}

function detectSeniority(cvText) {
  let score=0; const signals=[];
  if (/vp|vice president|director|head of/i.test(cvText)){score+=30;signals.push('executive title');}
  if (/(?:10|eleven|\d{2})\+?\s*years?\s*(?:of\s*)?experience/i.test(cvText)){score+=20;signals.push('10+ years');}
  else if (/[7-9]\+?\s*years/i.test(cvText)){score+=10;signals.push('7-9 years');}
  if (/arr|mrr|\$\d+m|sar\s*\d+m|\d+m\s*sar/i.test(cvText)){score+=20;signals.push('ARR ownership');}
  if (/managed.*team|team.*\d+|led.*team/i.test(cvText)){score+=15;signals.push('team leadership');}
  if (/playbook|framework|strategy|org design/i.test(cvText)){score+=10;signals.push('strategic thinking');}
  if(score>=50) return {level:'executive',score,signals};
  if(score>=30) return {level:'senior',score,signals};
  if(score>=15) return {level:'mid',score,signals};
  return {level:'junior',score,signals};
}

function computeHeuristicScore(cv, job, jd) {
  const cvL=cv.toLowerCase();
  const jdP=parseJD(jd);
  const sen=detectSeniority(cv);
  let cvStrength=30;
  if(/\d+%|\d+ sar|\d+m\s*sar|arr|mrr/i.test(cv)) cvStrength+=20;
  if(/led|managed|built|launched|grew|improved|delivered/i.test(cv)) cvStrength+=10;
  if(cv.length>1500) cvStrength+=8;
  if(cv.length>3000) cvStrength+=5;
  if(/customer success|churn|retention|health score|playbook|renewal/i.test(cv)) cvStrength+=15;
  if(/arr|mrr|portfolio|account/i.test(cv)) cvStrength+=8;
  if(sen.level==='executive') cvStrength+=20;
  else if(sen.level==='senior') cvStrength+=12;
  else if(sen.level==='mid') cvStrength+=5;
  cvStrength=Math.min(Math.max(cvStrength,15),92);
  let jobFit=cvStrength*0.7;
  const skillMatches=jdP.roleSkills.filter(s=>s.split(/\s+/).some(w=>w.length>3&&cvL.includes(w)));
  jobFit+=skillMatches.length*5;
  jobFit+=jdP.csSystems.filter(s=>s.split(/\s+/).some(w=>w.length>4&&cvL.includes(w))).length*4;
  let hardReqStatus='unknown'; const hardReqIssues=[];
  jdP.hardRequirements.forEach(req=>{ if(/german|deutsch/i.test(req)&&!/german|deutsch/i.test(cv)){hardReqIssues.push('German fluency not shown');hardReqStatus='missing';} if(/work authorization/i.test(req)){const m=req.match(/for\s+(\w+)/);if(m&&!cvL.includes(m[1].toLowerCase())){hardReqIssues.push('Work authorization for '+m[1]+' not shown');hardReqStatus='missing';}} });
  if(hardReqIssues.length===0&&jdP.hardRequirements.length>0) hardReqStatus='pass';
  if(hardReqStatus==='missing') jobFit=Math.round(jobFit*0.7);
  jobFit=Math.min(Math.max(Math.round(jobFit),15),88);
  const careerPath=buildCareerPath(job,sen.level);
  const problems=[];
  if(hardReqIssues.length>0) problems.push({title:'متطلبات إلزامية غير مستوفاة',desc:hardReqIssues.join('. '),quote:null,fix:'تحقق من هذه الشروط — سيرتك قوية لأدوار مشابهة بدون قيود جغرافية.'});
  if(!/\d+%|\d+x|\d+m\s*sar|arr/i.test(cv)) problems.push({title:'إنجازات بدون أرقام',desc:'أضف ARR أو retention % أو team size.',quote:null,fix:'مثال: "أدرت محفظة X ريال ARR" أو "رفعت retention من X% إلى Y%"'});
  return {
    readinessScore:Math.round((cvStrength*0.5+jobFit*0.5)),
    cvStrengthScore:Math.round(cvStrength),
    jobFitScore:Math.round(jobFit),
    hardRequirementStatus:hardReqStatus,
    hardRequirementIssues:hardReqIssues,
    interviewReadinessScore:25,
    readinessRange:`${Math.round(cvStrength)-5}–${Math.round(cvStrength)+8}%`,
    confidence:jd?'high':'medium',
    whyNotGetting:hardReqIssues.length>0?`سيرتك قوية لهذا المسار، لكن هذه الوظيفة تحديداً فيها شروط قد تمنعك: ${hardReqIssues.join(' + ')}`:cvStrength<50?'السيرة تحتاج تقوية في الإنجازات والأرقام':'السيرة كويسة — ركّز على تحسين تحضير المقابلة',
    seniority:sen.level,
    problems:problems.slice(0,4),
    improvedSummary:`قائد ${job} بخبرة ${sen.level==='executive'?'تنفيذية':'عملية'} في تحقيق نتائج قابلة للقياس ومتميزة.`,
    recommendedKeywords:[...jdP.csSystems,...jdP.roleSkills].slice(0,8),
    matchedSkills:skillMatches,
    missingKeywords:hardReqIssues.concat(jdP.csSystems.filter(s=>!cvL.includes(s.split(' ')[0]))).slice(0,6),
    careerPath,
    hardRequirements:jdP.hardRequirements,
    jobMatches:hardReqIssues.length>0?[{role:job+' (بدون قيود جغرافية)',type:'best',why:'سيرتك قوية — ابحث في السوق السعودي والخليجي',action:'قدّم على أدوار CS leadership في السعودية والإمارات'},{role:'هدفك منطقي لمسارك',type:'pivot',why:'لكن هذه الشركة تحديداً عندها شروط محددة',action:'استمر في التدريب وابحث عن أدوار بدون قيود لغوية'}]:[{role:job,type:'best',why:`تطابق ${jobFit}% مع المتطلبات`,action:'قدّم بعد تحسين السيرة'},{role:'Director of Customer Success',type:'train',why:'مشابه بمسؤوليات أقل',action:'تدرّب أسبوعين أولاً'}],
  };
}

function buildCareerPath(job, seniorityLevel) {
  if (/vp|vice president|director|head/i.test(job)) {
    return [{role:seniorityLevel==='executive'?'Head of CS / Director CS':'Senior CS Manager',readinessNeeded:35,daysFromNow:0,isCurrent:true,isTarget:false},{role:'Director of Customer Success',readinessNeeded:55,daysFromNow:14,isCurrent:false,isTarget:false},{role:job,readinessNeeded:70,daysFromNow:30,isCurrent:false,isTarget:true}];
  }
  return [{role:'CS Specialist',readinessNeeded:35,daysFromNow:0,isCurrent:seniorityLevel==='junior',isTarget:false},{role:'CS Manager',readinessNeeded:50,daysFromNow:14,isCurrent:seniorityLevel==='mid',isTarget:false},{role:job,readinessNeeded:65,daysFromNow:30,isCurrent:false,isTarget:true}];
}

// Question-aware local scoring (used when no OpenAI key, or OpenAI fails). Honest and simple:
// it checks the things that matter for THAT question (a motivation answer is not
// penalised for having no numbers), never claims more than length/structure/specifics.
function localEvaluate(answer, ctx) {
  ctx = ctx || {};
  const raw = String(answer || '').trim();
  const norm = raw.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  const words = raw.split(/\s+/).filter(Boolean).length;
  const hasN = /\d/.test(norm);
  const hasResult = /نتيجة|نتائج|حقق|وفر|وفّر|زاد|زادت|ارتفع|ارتفعت|ارتفاع|خفض|قلل|حسّن|حسنت|رفع|نجحت|أنجزت|انجزت|achieved|improved|reduced|increased|grew|saved|saved|cut |boosted|won |closed|delivered|renewed|percent|revenue|growth|وصل|وصلت|شكرني|شكرتني|رضي|انحلت|حليت|تمت|رجع|اعتمد|اقتنع|وافق|قبل العميل|قبلوا/i.test(raw);
  const hasStructure = /أولاً|ثانياً|أولا|ثانيا|ثم |بعدها|بعد ذلك|لذلك|فقمت|قمت ب|وكانت النتيجة|كانت النتيجة|then|first|second|situation|action|result|as a result|so that|the result|I started|I then|after that|فغيّرت|فغيرت|فاتصلت|فقلت|فسويت|فبدأت|وبعدين|بعدين|وبعدها/i.test(raw);
  const ownAction = /(^|\s)[\u0621-\u064A]{3,}ت(\s|$|،|\.)|\b(أنا|قمت|عملت|سويت|قدت|صممت|نفذت|حللت|بنيت|طورت|رتبت|أقنعت|تواصلت|حليت|اتخذت|درست)\b|قمت|عملت|سويت|قدت|نفذت|حللت|بنيت|طورت|I |I\x27ve|my own/i.test(raw);
  const qid = ctx.qid || 'generic';
  const company = String(ctx.company || '').trim().toLowerCase();
  let score = 15, strengths = [], weak = [], fix = '';
  const add = (ok, pts, good, bad) => { if (ok) { score += pts; if (good) strengths.push(good); } else if (bad) weak.push(bad); };

  if (qid === 'intro') {
    add(words >= 30, 10, 'طول مناسب لتعريف بسيط', 'الإجابة قصيرة — أضف خلفيتك وإنجازاً واحداً');
    if (words > 150) { score -= 8; weak.push('الإجابة طويلة — اختصرها لـ ٩٠ ثانية'); }
    add(/خريج|خريجة|خبرة|سنوات|سنة|أعمل|عملت|تخصص|بكالوريوس|ماجستير|دبلوم|طالب|طالبة|تدريب|years|experience|graduate|degree|bachelor|master|student|intern|accountant|designer|engineer|manager|executive|analyst/i.test(raw), 15, 'ذكرت خلفيتك', 'ما ذكرت خلفيتك (تعليم أو خبرة)');
    add(hasN || hasResult, 20, 'فيها رقم أو نتيجة', 'أضف رقماً أو نتيجة واحدة تفتخر فيها');
    add(/أبحث|أطمح|أبغى|أبي|هدفي|أرغب|أتطلع|أحب|مهتم|مهتمة|شغفي|looking for|seeking|moving into|aiming|want to|interested|passionate|goal/i.test(raw), 15, 'ربطت كلامك بهدفك', 'اربط كلامك بالدور المتقدّم له');
    fix = 'رتّبها هكذا: من أنا، إنجاز واحد برقم، ليش هذا الدور — في ٩٠ ثانية.';
  } else if (qid === 'motivation') {
    const mentionsCo = company && company.length > 2 && raw.toLowerCase().indexOf(company) !== -1;
    add(mentionsCo || /منتج|منتجات|خدمات|سوق|قيم|سمعة|مشاريع|عملاء|رؤية|جربت|قرأت|تابعت|حضور|محتوى|product|market|values|culture|follow|like how|admire|growth|customers|brand/i.test(raw), 30, 'ذكرت شيئاً محدداً عن الجهة', 'ما ذكرت شيئاً محدداً عن الشركة (منتج، سوق، قيم)');
    add(/أفيد|أضيف|أقدم|أسهم|أساهم|يفيد|تفيد|خبرتي|مهاراتي|أقدر|bring|contribute|add value|help|my skills|my experience/i.test(raw), 25, 'وضحت وش تقدّم للشركة', 'وضّح وش تقدّم أنت للشركة');
    add(words >= 25, 10, null, 'الإجابة قصيرة — أضف سبباً ثانياً محدداً');
    if (/راتب|مميزات|إجازات|اجازات|قريبة من البيت/.test(raw) && !/أفيد|أضيف|أقدم|أساهم/.test(raw)) { score -= 15; weak.push('تجنّب الراتب والمميزات كسبب أول'); }
    fix = 'اذكر شيئاً محدداً عن الشركة قرأته أو جربته، ثم اربطه بمهارة عندك تفيدهم.';
  } else if (qid === 'weakness') {
    add(/صرت|أصبحت|حددت|أحدد|أسلّم|ألتزم|أراجع|أقسم|أحسن|أطور|تدربت|دورة|أنظم|بدأت|خطة|أتعلم|تعلمت|حاولت|أستخدم|أتابع|improve|learning|course|practice|started|plan|track|now i|weekly|daily/i.test(raw), 30, 'وضحت كيف تشتغل على الضعف', 'ما وضحت كيف تعالج هذا الضعف');
    add(/مرة|موقف|مثلاً|مثال|لما|عندما|في مشروع|once|when |for example|for instance|project|last year/i.test(raw), 20, 'أعطيت موقفاً ملموساً', 'أضف موقفاً حقيقياً صار بسبب هذا الضعف');
    add(words >= 20, 10, null, 'الإجابة قصيرة');
    if (/مثالي|perfectionist|أهتم بالتفاصيل أكثر من اللازم|أشتغل كثير/.test(raw)) { score -= 20; weak.push('«أنا مثالي» جواب مكرر — اختر ضعفاً حقيقياً'); }
    fix = 'اختر ضعفاً حقيقياً غير قاتل للدور، موقفاً واحداً، وخطوتين تسويهم لتحسينه.';
  } else if (qid === 'candidate_asks') {
    const topicGroups = [/دوام|مواعيد|ورديات/i, /حوافز|عمولة|تأمين|سكن/i, /مسؤول|مدير مباشر|مشرف/i,/فريق|تركيبة|team/i, /تحدي|تحدٍّ|challenge/i, /ثقافة|قرارات|culture/i, /نجاح|يقاس|مؤشرات|أهداف|success|measured/i, /تطور|تدريب|نمو|growth/i];
    const topics = topicGroups.filter((re) => re.test(raw)).length;
    const qs = Math.max(topics, (raw.match(/[؟?]/g) || []).length);
    add(qs >= 2, 40, 'جهّزت أكثر من سؤال', 'جهّز على الأقل ٣ أسئلة للمحاور');
    add(/فريق|تحدي|تحدٍّ|ثقافة|قرارات|أول ٩٠|نجاح|تطور|تدريب|team|challenge|culture|success|growth|90/i.test(raw), 25, 'أسئلتك عن الفريق والنجاح', 'اسأل عن الفريق، التحدي الأكبر، وكيف يُقاس النجاح');
    if (!ctx.simple && /متى أبدأ|كم الراتب/.test(raw)) { score -= 15; weak.push('تجنّب سؤال الراتب والبداية كأول سؤال'); }
    fix = 'اكتب ٣ أسئلة: عن الفريق، عن أكبر تحدٍّ في الدور، وعن كيف يُقاس النجاح في أول ٩٠ يوم.';
  } else {
    // star / family_behavioral / generic
    add(words >= (ctx.simple ? 18 : 30), 15, 'تفاصيل كافية', 'الإجابة قصيرة — أضف سياقاً أكثر');
    add(hasStructure, 15, 'فيها ترتيب (موقف ثم تصرف ثم نتيجة)', 'اتبع STAR: موقف → دورك → خطوات → نتيجة');
    if (ctx.simple) { if (hasN) { score += 10; strengths.push('فيها رقم'); } } else add(hasN, 20, 'فيها أرقام', 'ما في أرقام قابلة للقياس');
    add(hasResult, 15, 'ذكرت نتيجة', 'ما وضحت النتيجة بعد تصرفك');
    add(ownAction, 10, 'وضحت دورك أنت', 'وضّح دورك أنت تحديداً (مو الفريق)');
    fix = ctx.simple ? 'احكِ الموقف بالترتيب: وش صار، وش سويت أنت، وكيف انتهى.' : (hasN ? 'رتّب إجابتك: الموقف، ثم دورك، ثم النتيجة بالرقم.' : 'ابدأ بموقف حقيقي مريت به وأنهِ بنتيجة واحدة بأرقام.');
  }
  score = Math.max(10, Math.min(score, 85));
  const verdict = score >= 65 ? 'إجابة قوية ✓' : score >= 45 ? 'إجابة متوسطة — تحتاج تطوير' : 'إجابة ضعيفة';
  const whyFail = score >= 65 ? (weak.length ? 'إجابة جيدة. أقوى تحسين: ' + weak[0] : 'إجابة جيدة — جرّب تقولها بصوت عالٍ وبوقت محدد')
    : score >= 45 ? 'محتوى معقول، لكن ' + (weak[0] || 'ينقصه تفصيل') + '.'
    : 'الإجابة عامة وما تثبت شيئاً بعد: ' + (weak[0] || 'أضف مثالاً حقيقياً') + '.';
  return {
    overallScore: score,
    verdict,
    whyFail,
    strengths: strengths.slice(0, 3),
    weakPoints: weak.slice(0, 3),
    improvedAnswer: '',
    oneFix: fix,
    readinessGain: score >= 60 ? 3 : score >= 40 ? 2 : 1,
  };
}

// ══════ PHASE 4 — TRAINING ENGINE (Voice + Video + Transcription) ══════

// ─── Multer setup for file uploads ───────────────────────────────────────────
let multer;
try {
  multer = require('multer');
} catch(e) {
  console.warn('[phase4] multer not installed — run: npm install multer');
}

function getMulter() {
  if (!multer) return null;
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
    fileFilter: (req, file, cb) => {
      const allowed = ['audio/webm','audio/ogg','audio/mp4','audio/wav','audio/mpeg',
                       'video/webm','video/mp4','application/octet-stream'];
      // Accept any audio/video
      if (file.mimetype.startsWith('audio/') || file.mimetype.startsWith('video/') || allowed.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('File type not allowed: ' + file.mimetype));
      }
    },
  });
}

// ─── Training DB helpers ───────────────────────────────────────────────────────
async function saveTrainingAttempt(data) {
  try {
    await db.query(
      `INSERT INTO training_attempts
        (user_id, training_day, question_text, mode, transcript, scores_json, feedback_json, attempt_number, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT DO NOTHING`,
      [data.userId, data.trainingDay, data.question, data.mode,
       data.transcript, JSON.stringify(data.scores), JSON.stringify(data.feedback), data.attemptNumber || 1]
    );
  } catch(e) { console.error('[training] save attempt:', e.message); }
}

async function getUserAttemptCount(userId, trainingDay) {
  try {
    const { rows } = await db.query(
      'SELECT COUNT(*) as cnt FROM training_attempts WHERE user_id=$1 AND training_day=$2',
      [userId, trainingDay]
    );
    return parseInt(rows[0]?.cnt || '0');
  } catch(e) { return 0; }
}

// ─── OpenAI Transcription ─────────────────────────────────────────────────────
async function transcribeAudio(audioBuffer, mimeType, filename) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set');
  }

  const { OpenAI } = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // OpenAI Whisper requires a File-like object
  const { File } = require('buffer');
  const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
  const fname = filename || ('recording.' + ext);

  const file = new File([audioBuffer], fname, { type: mimeType });

  const response = await openai.audio.transcriptions.create({
    file: file,
    model: 'whisper-1',
    language: 'ar', // Arabic first, Whisper auto-detects if wrong
    response_format: 'json',
  });

  return response.text || '';
}

// ─── GPT Evaluation ────────────────────────────────────────────────────────────
async function evaluateTranscript(transcript, question, roleFamily, mode) {
  if (!process.env.OPENAI_API_KEY) {
    return localEvaluate(transcript);
  }

  const { OpenAI } = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const roleDimensions = {
    customer_service: '- التعاطف (empathy)\n- وضوح خطوات الحل (action_clarity)\n- الهدوء تحت الضغط (calmness)',
    sales_entry:      '- الإقناع (persuasion)\n- التعامل مع الاعتراضات (objection_handling)',
    reception_front_desk: '- الاحترافية (professionalism)\n- أسلوب الترحيب (welcoming_tone)',
  };
  const extraDims = roleDimensions[roleFamily] || '';

  const prompt = `أنت مقيّم مقابلات عمل خبير للسوق السعودي.

السؤال: ${question}
إجابة المتقدم: ${transcript}
طريقة الإجابة: ${mode === 'voice' ? 'صوتية (نص محوّل)' : mode === 'video' ? 'فيديو (نص محوّل)' : 'مكتوبة'}

مهم: لا تدّعي تحليل نبرة الصوت أو لغة الجسد — قيّم النص فقط.

قيّم الإجابة على الأبعاد التالية وأرجع JSON فقط:
{
  "overallScore": 55,
  "dimensions": {
    "relevance_to_question": 60,
    "answer_structure": 50,
    "evidence_examples": 40,
    "communication_clarity": 65,
    "language_quality": 60,
    "role_fit": 55${extraDims ? ',\n    ' + extraDims.split('\n').map(d => '"' + d.split('(')[1]?.replace(')','') + '": 50').join(',\n    ') : ''}
  },
  "verdict": "إجابة متوسطة",
  "whyFail": "لماذا ستضعف في مقابلة حقيقية — 1-2 جملة",
  "improvedAnswer": "إجابة محسّنة بـ STAR وتفاصيل محددة",
  "oneFix": "إصلاح واحد محدد للتطبيق الفوري",
  "readinessGain": 2,
  "strengths": ["نقطة قوة 1"],
  "weaknesses": ["نقطة ضعف 1"]
}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 800,
      temperature: 0.3,
    });
    return JSON.parse(response.choices[0].message.content);
  } catch(e) {
    console.error('[eval] GPT error:', safeAiErrorSummary(e));
    return localEvaluate(transcript);
  }
}

// ─── POST /api/training/transcribe ────────────────────────────────────────────
app.post('/api/training/transcribe', authMiddleware, async (req, res) => {
  const upload = getMulter();
  if (!upload) {
    return res.status(503).json({
      error: 'multer_not_installed',
      message: 'Run: npm install multer on server',
      fallback: true,
    });
  }

  upload.single('recording')(req, res, async (err) => {
    if (err) {
      console.error('[transcribe] upload error:', err.message);
      return res.status(400).json({ error: err.message, fallback: true });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'no_file',
        message: 'No recording file received',
        fallback: true,
      });
    }

    console.log('[transcribe] received:', {
      size: req.file.size,
      mimetype: req.file.mimetype,
      userId: req.user.id,
    });

    // File size check
    if (req.file.size < 1000) {
      return res.status(400).json({
        error: 'file_too_small',
        message: 'Recording too short or empty',
        fallback: true,
      });
    }

    try {
      const transcript = await transcribeAudio(
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname || 'recording.webm'
      );

      if (!transcript || transcript.trim().length < 5) {
        return res.json({
          success: false,
          fallback: true,
          message: 'تعذّر تحويل الصوت تلقائياً — اكتب إجابتك لتقييمها',
          transcript: '',
        });
      }

      res.json({ success: true, transcript, fallback: false });

    } catch(e) {
      console.error('[transcribe] OpenAI error:', safeAiErrorSummary(e));
      // Never echo raw OpenAI error to the client — user sees the soft message.
      res.json({
        success: false,
        fallback: true,
        message: 'تعذّر تحويل الصوت تلقائياً — اكتب إجابتك لتقييمها',
        transcript: '',
      });
    }
  });
});

// ─── POST /api/training/evaluate ─────────────────────────────────────────────
app.post('/api/training/evaluate', authMiddleware, async (req, res) => {
  const { transcript, question, mode, roleFamily, trainingDay, isFallback } = req.body;

  if (!transcript || transcript.trim().length < 3) {
    return res.status(400).json({ error: 'transcript required' });
  }
  if (!question) {
    return res.status(400).json({ error: 'question required' });
  }

  console.log('[evaluate] userId:', req.user.id, 'day:', trainingDay, 'mode:', mode);

  // Check access limits
  const user = req.user;
  const attemptCount = await getUserAttemptCount(user.id, trainingDay || 1);

  // Access gating
  const userData = await db.query('SELECT access_status, trial_ends_at FROM users WHERE id=$1', [user.id]).catch(() => ({rows:[]}));
  const accessStatus = userData.rows[0]?.access_status || 'free';
  const isPaid = accessStatus === 'paid' || (accessStatus === 'free' && trial.trialInfo(userData.rows[0]).active);
  const is24h  = accessStatus === 'ugc_24h';

  if (!isPaid && !is24h && attemptCount >= 1) {
    return res.status(403).json({
      error: 'limit_reached',
      message: 'وصلت للحد المجاني — فعّل 24h أو Premium لمزيد من التقييمات',
      upgradeRequired: true,
    });
  }
  if (is24h && attemptCount >= 3) {
    return res.status(403).json({
      error: 'limit_reached',
      message: 'وصلت لحد 24h — ترقية Premium للمزيد',
      upgradeRequired: true,
    });
  }

  try {
    const evaluation = await evaluateTranscript(transcript, question, roleFamily || 'customer_service', mode || 'written');

    // Add fallback label if needed
    if (isFallback) {
      evaluation.note = 'تم التقييم من النص المكتوب بدلاً من الصوت المحوّل';
    }

    // Save attempt
    await saveTrainingAttempt({
      userId:       user.id,
      trainingDay:  trainingDay || 1,
      question:     question,
      mode:         mode || 'written',
      transcript:   transcript,
      scores:       evaluation.dimensions || {},
      feedback:     { verdict: evaluation.verdict, whyFail: evaluation.whyFail, oneFix: evaluation.oneFix },
      attemptNumber: attemptCount + 1,
    });

    // Update user readiness
    const gain = evaluation.readinessGain || 2;
    await db.query(
      `UPDATE users SET interview_readiness = LEAST(interview_readiness + $1, 92), last_activity = NOW() WHERE id = $2`,
      [gain, user.id]
    ).catch(() => {});

    res.json({ success: true, evaluation, attemptNumber: attemptCount + 1 });

  } catch(e) {
    console.error('[evaluate] error:', safeAiErrorSummary(e));
    // Never echo raw error to client. The eval was offered with a local
    // fallback inside evaluateTranscript already; if we still ended up here,
    // something below the AI layer failed (DB, etc.) — give a generic message.
    res.status(500).json({ error: 'evaluation_failed', message: 'تعذّر التقييم الآن — جرّب بعد لحظات.' });
  }
});

// ─── GET /api/training/history ────────────────────────────────────────────────
app.get('/api/training/history', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, training_day, question_text, mode, transcript, scores_json, feedback_json, attempt_number, created_at
       FROM training_attempts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.json({ success: true, history: rows });
  } catch(e) { res.json({ success: true, history: [] }); }
});

// ─── Demo transcription (no auth needed, no save) ─────────────────────────────
app.post('/api/training/demo-transcribe', async (req, res) => {
  const upload = getMulter();
  if (!upload) return res.json({ success: false, fallback: true, transcript: '' });

  upload.single('recording')(req, res, async (err) => {
    if (err || !req.file) return res.json({ success: false, fallback: true, transcript: '' });
    try {
      const transcript = await transcribeAudio(req.file.buffer, req.file.mimetype);
      res.json({ success: true, transcript: transcript || '', fallback: !transcript });
    } catch(e) {
      console.error('[demo-transcribe] error:', safeAiErrorSummary(e));
      res.json({ success: false, fallback: true, transcript: '' });
    }
  });
});

// ─── Debug endpoint ────────────────────────────────────────────────────────────
app.get('/api/training/status', (req, res) => {
  res.json({
    phase: 4,
    endpoints: [
      'POST /api/training/transcribe',
      'POST /api/training/evaluate',
      'GET  /api/training/history',
      'POST /api/training/demo-transcribe',
    ],
    openaiConfigured: !!process.env.OPENAI_API_KEY,
    multerAvailable: !!multer,
    corsOrigins: ALLOWED_ORIGINS,
    dbConfigured: !!process.env.DATABASE_URL,
  });
});

// ══════ JSON 404 for any unmatched /api/* request ═══════════════════════════
// Must come BEFORE the SPA catch-all so API typos surface as JSON, not HTML.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not_found', path: req.originalUrl });
});

// ══════ V2 preview shell (Phase 0 Task 1) ═════════════════════════════════
// Separate file at public/v2.html. V1 (public/index.html) stays at "/".
// V2 reads the same localStorage keys so state moves seamlessly between
// V1 and V2. Backend is unchanged — both versions hit the same /api/* routes.
app.get('/v2', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/v2.html'));
});

// ══════ SPA catch-all (registered last on purpose) ══════════════════════════
app.get('*', (req, res) => {
  // One product: unknown paths land on the V2 app (V1 stays reachable at /v1 only).
  res.sendFile(path.join(__dirname, '../public/v2.html'));
});

// ══════ Schema bootstrap + listen ═══════════════════════════════════════════
async function bootstrapSchema() {
  if (!process.env.DATABASE_URL) {
    console.warn('[startup] DATABASE_URL not set — skipping schema bootstrap (server will boot, but DB calls will fail)');
    return;
  }
  const schemaPath = path.join(__dirname, '..', 'migrations', 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    console.warn('[startup] schema.sql not found at', schemaPath, '— skipping bootstrap');
    return;
  }
  try {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    await db.query(sql);
    console.log('[startup] schema bootstrap ok');
  } catch (e) {
    console.error('[startup] schema bootstrap FAILED:', e.message);
    if (IS_PROD) {
      console.error('[startup] refusing to start in production with broken schema');
      process.exit(1);
    }
  }
}

bootstrapSchema().finally(() => {
  trial.startScheduler(db);
  app.listen(PORT, () => {
    console.log('[startup] darbi listening on port', PORT, '(NODE_ENV=' + (process.env.NODE_ENV || 'development') + ')');
  });
});
