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

function localEvaluate(answer) {
  const words=answer.trim().split(/\s+/).length;
  const hasN=/\d+/.test(answer);
  const hasResult=/نتيجة|حقق|وفّر|زاد|achieved|improved|reduced/i.test(answer);
  const hasStructure=/أولاً|ثانياً|then|first|second|star|situation|action|result/i.test(answer);
  const score=Math.min(15+(words>50?20:words>25?10:0)+(hasN?20:0)+(hasResult?20:0)+(hasStructure?15:0),80);
  return {
    overallScore:score,
    verdict:score>=65?'إجابة قوية ✓':score>=45?'إجابة متوسطة — تحتاج تطوير':'إجابة ضعيفة',
    whyFail:score<40?'الإجابة عامة — تحتاج مثال حقيقي بسياق + دور + خطوات + رقم':score<60?'محتوى جيد لكن يفتقر لأرقام أو هيكل STAR':'إجابة جيدة — أضف رقماً واحداً محدداً',
    weakPoints:[!hasN&&'ما في أرقام أو نتائج قابلة للقياس',words<30&&'الإجابة قصيرة — أضف سياقاً أكثر',!hasStructure&&'اتبع STAR: موقف → دور → خطوات → نتيجة'].filter(Boolean),
    improvedAnswer:'في [الشركة]، واجهنا [مشكلة]. دوري كان [ما فعلت]. النتيجة: [X% تحسن أو Y ريال توفير].',
    oneFix:'ابدأ بـ "في [المكان]" وأضف نتيجة واحدة بأرقام في النهاية',
    readinessGain:score>=60?3:score>=40?2:1,
  };
}

app.listen(PORT, () => console.log(`Darbi running on port ${PORT}`));
