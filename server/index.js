require('dotenv').config();
const express = require('express');
const path    = require('path');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ─── Serve frontend ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ─── DB (PostgreSQL) ──────────────────────────────────────────────────────────
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── Helpers ──────────────────────────────────────────────────────────────────
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'darbi_secret_2025';

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
    res.json({ success: true, token, user: { id: rows[0].id, email: rows[0].email, access_status: rows[0].access_status, referral_code: rows[0].referral_code, paid: rows[0].access_status === 'paid' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/darbi/me', authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id, email, access_status, referral_code, created_at FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, user: { ...rows[0], paid: rows[0].access_status === 'paid' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ANALYSIS ─────────────────────────────────────────────────────────────────
app.post('/api/darbi/analyze', authMiddleware, async (req, res) => {
  const { targetRole, cvText, jobDescription = '' } = req.body;
  if (!targetRole || !cvText) return res.status(400).json({ error: 'Missing fields' });

  if (!process.env.OPENAI_API_KEY) {
    // Heuristic fallback
    const score = computeHeuristicScore(cvText, targetRole, jobDescription);
    return res.json({ success: true, result: score });
  }

  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const prompt = `أنت محلل سيرة ذاتية محترف للسوق السعودي.

الوظيفة المستهدفة: ${targetRole}
${jobDescription ? `وصف الوظيفة: ${jobDescription.substring(0, 500)}` : ''}

السيرة الذاتية:
${cvText.substring(0, 2000)}

حلّل السيرة الذاتية وأرجع JSON فقط:
{
  "readinessScore": 35,
  "readinessRange": "30-40%",
  "whyNotGetting": "سبب عدم الحصول على مقابلات",
  "confidence": "high|medium|low",
  "problems": [{"title": "المشكلة", "desc": "التفاصيل", "quote": "من السيرة", "fix": "الحل"}],
  "improvedSummary": "ملخص محسّن",
  "recommendedKeywords": ["كلمة1", "كلمة2"],
  "matchedSkills": ["مهارة موجودة"],
  "missingKeywords": ["كلمة ناقصة"],
  "jobMatches": [{"role": "دور مناسب", "type": "best|train|pivot", "why": "السبب", "action": "الإجراء"}]
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
    console.error('AI analyze error:', e.message);
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
  const { sessionId, questionText, answerText, targetSkill } = req.body;
  if (!answerText) return res.status(400).json({ error: 'Missing answer' });

  if (!process.env.OPENAI_API_KEY) {
    return res.json({ success: true, evaluation: localEvaluate(answerText) });
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
    console.error('Training eval error:', e.message);
    res.json({ success: true, evaluation: localEvaluate(answerText) });
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

// ─── PAYMENT (Stripe) ─────────────────────────────────────────────────────────
app.post('/api/payment/checkout', authMiddleware, async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const { plan = 'lifetime' } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: plan === 'lifetime' ? 'Darbi Premium — Lifetime' : 'Darbi Premium — Monthly' },
          unit_amount: plan === 'lifetime' ? 19900 : 4900,
          recurring: plan === 'monthly' ? { interval: 'month' } : undefined,
        },
        quantity: 1,
      }],
      mode: plan === 'monthly' ? 'subscription' : 'payment',
      success_url: `${process.env.APP_URL || 'http://localhost:3000'}/?payment_success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL || 'http://localhost:3000'}/?payment_cancelled=true`,
      customer_email: req.user.email,
      metadata: { userId: req.user.id, plan },
    });
    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return res.json({ received: true });
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) { return res.status(400).json({ error: e.message }); }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.userId;
    if (userId) {
      await db.query(
        `UPDATE users SET access_status = 'paid', paid_at = NOW() WHERE id = $1`,
        [userId]
      ).catch(() => {});
    }
  }
  res.json({ received: true });
});

app.post('/api/darbi/payment/success', authMiddleware, async (req, res) => {
  const { stripeSessionId } = req.body;
  try {
    await db.query(
      `UPDATE users SET access_status = 'paid', paid_at = NOW() WHERE id = $1`,
      [req.user.id]
    );
    res.json({ success: true });
  } catch (e) { res.json({ success: false }); }
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

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Heuristic fallback (no AI) ───────────────────────────────────────────────
function computeHeuristicScore(cv, job, jd) {
  const cvL = cv.toLowerCase();
  const src = (jd || job).toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const hits = src.filter(w => cvL.includes(w)).length;
  const kwScore = Math.min((hits / Math.max(src.length, 1)) * 100, 100);
  const hasNumbers = /\d+%|\d+ ريال|\d+ مليون/i.test(cv);
  const hasAction = /قاد|حقق|طور|نفذ|led|managed|improved/i.test(cv);
  const evScore = (hasNumbers ? 40 : 0) + (hasAction ? 30 : 0) + (cv.length > 1000 ? 30 : 15);
  const total = Math.round(kwScore * 0.4 + evScore * 0.4 + Math.min(cv.length / 30, 20) * 0.2);
  const score = Math.min(Math.max(total, 15), 70);
  return {
    readinessScore: score,
    readinessRange: `${score - 5}–${score + 8}%`,
    whyNotGetting: score < 40 ? 'السيرة تفتقر للكلمات المفتاحية والإنجازات القابلة للقياس' : 'السيرة كويسة لكن تحتاج تخصيص أكثر للوظيفة',
    confidence: jd ? 'medium' : 'low',
    problems: [
      !hasNumbers && { title: 'ما في أرقام أو إنجازات قابلة للقياس', desc: 'أضف أرقاماً لكل إنجاز', quote: null, fix: 'حوّل المهام لنتائج: "زادت بـ X%"' },
      !hasAction && { title: 'أفعال ضعيفة', desc: 'استخدم أفعال قوية', quote: null, fix: 'قاد / طوّر / حقّق / نفّذ' },
    ].filter(Boolean),
    improvedSummary: `متخصص في ${job} يتميز بخبرة عملية وقدرة على تحقيق نتائج قابلة للقياس.`,
    recommendedKeywords: src.slice(0, 6),
    matchedSkills: [],
    missingKeywords: src.filter(w => !cvL.includes(w)).slice(0, 5),
    jobMatches: [{ role: job, type: 'best', why: 'يناسب خلفيتك', action: 'قدّم مع تحسين السيرة' }],
  };
}

function localEvaluate(answer) {
  const words = answer.trim().split(/\s+/).length;
  const hasN = /\d+/.test(answer);
  const hasResult = /نتيجة|حقق|وفّر|زاد|achieved|improved/i.test(answer);
  const score = Math.min(20 + (words > 30 ? 15 : 0) + (hasN ? 20 : 0) + (hasResult ? 20 : 0), 75);
  return {
    overallScore: score,
    verdict: score >= 60 ? 'إجابة قوية' : score >= 40 ? 'إجابة متوسطة' : 'إجابة تحتاج تطوير',
    whyFail: score < 40 ? 'الإجابة عامة — تحتاج مثال حقيقي بأرقام' : 'الإجابة كويسة — أضف رقماً واحداً لتكون أقوى',
    weakPoints: [!hasN && 'ما في أرقام أو نتائج قابلة للقياس', words < 20 && 'الإجابة قصيرة جداً'].filter(Boolean),
    improvedAnswer: 'في [الشركة]، واجهنا [مشكلة]. دوري كان [ما فعلت]. النتيجة: [رقم أو نتيجة محددة].',
    oneFix: 'أضف رقماً واحداً أو نتيجة محددة لإجابتك',
    readinessGain: score >= 50 ? 3 : 1,
  };
}

app.listen(PORT, () => console.log(`Darbi running on port ${PORT}`));
