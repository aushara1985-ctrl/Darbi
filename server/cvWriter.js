// ══════ Darbi CV writer ════════════════════════════════════════════════════
// Darbi writes the stronger CV itself (it does not only critique): the person
// answers 3–4 short questions about the goal, and gets a complete CV, in
// Arabic and/or English, built ONLY from what they provided.
//
// Honesty rules enforced here, not just asked of the model:
//   - nothing invented: every number in the output must exist in the person's
//     own text (or in an answer / edit instruction they typed);
//   - what is missing becomes a short question, never a guess;
//   - when the AI is not available the result is a plain structured copy of
//     their text, clearly labelled as non-AI.
//
// The OpenAI client is injected (deps.chat) so the logic is unit-testable.

const GOALS = {
  new_grad:      { ar: 'خريج جديد',     en: 'new graduate' },
  promotion:     { ar: 'ترقية',          en: 'promotion to a more senior role' },
  career_change: { ar: 'تغيير مجال',     en: 'career change into a new field' },
  target_role:   { ar: 'وظيفة محددة',    en: 'a specific target role' },
};

// Four ATS-friendly templates. All are single-column real text (no tables,
// no images); they differ in section order and typographic treatment.
const TEMPLATES = [
  { id: 'classic',   ar: 'كلاسيكي',        en: 'Classic',
    desc: 'الخبرة أول، ترتيب زمني واضح. الأنسب لأنظمة الفرز الآلي ولأغلب الوظائف.',
    order: ['summary', 'experience', 'education', 'skills', 'certifications', 'projects', 'languages'] },
  { id: 'graduate',  ar: 'خريج',           en: 'Graduate',
    desc: 'التعليم والمشاريع والتدريب أول. للخريج الجديد وقليل الخبرة.',
    order: ['summary', 'education', 'projects', 'experience', 'skills', 'certifications', 'languages'] },
  { id: 'skills',    ar: 'مهارات أول',     en: 'Skills-first',
    desc: 'المهارات المنقولة أول ثم الخبرة. لتغيير المجال.',
    order: ['summary', 'skills', 'experience', 'projects', 'education', 'certifications', 'languages'] },
  { id: 'executive', ar: 'قيادي',          en: 'Executive',
    desc: 'ملخص قوي ثم الإنجازات والخبرة. للترقية والأدوار القيادية.',
    order: ['summary', 'experience', 'skills', 'education', 'certifications', 'languages', 'projects'] },
];

const RECOMMEND = {
  new_grad:      { template: 'graduate',  reason: 'هدفك أول وظيفة بعد التخرج، فنقدّم تعليمك ومشاريعك وتدريبك قبل الخبرة.' },
  promotion:     { template: 'executive', reason: 'هدفك ترقية، فنبدأ بملخص يوضح مستواك ثم إنجازاتك في الخبرة.' },
  career_change: { template: 'skills',    reason: 'هدفك تغيير مجال، فنقدّم مهاراتك اللي تنتقل معك قبل المسميات السابقة.' },
  target_role:   { template: 'classic',   reason: 'هدفك وظيفة محددة، والقالب الكلاسيكي أوضح لأنظمة الفرز الآلي ولمسؤول التوظيف.' },
};

function recommendTemplate(goal) {
  return RECOMMEND[goal] || RECOMMEND.target_role;
}

// ─── text helpers ──────────────────────────────────────────────────────────
function toAsciiDigits(s) {
  return String(s == null ? '' : s)
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0));
}
function _str(v, max) {
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, max || 300);
}
function _list(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return [];
  return v.map(x => _str(typeof x === 'string' ? x : (x && (x.name || x.text || x.title)) || '', maxLen || 200))
    .filter(Boolean).slice(0, maxItems || 20);
}

// Coerce whatever the model (or the client) sent into the fixed CV shape.
function normalizeCv(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const c = (r.contact && typeof r.contact === 'object') ? r.contact : {};
  return {
    name:     _str(r.name, 120),
    headline: _str(r.headline, 160),
    contact: {
      email:    _str(c.email, 120),
      phone:    _str(c.phone, 40),
      city:     _str(c.city || c.location, 80),
      linkedin: _str(c.linkedin, 160),
    },
    summary: _str(r.summary, 900),
    experience: (Array.isArray(r.experience) ? r.experience : []).slice(0, 12).map(e => ({
      title:    _str(e && e.title, 120),
      company:  _str(e && e.company, 120),
      location: _str(e && e.location, 80),
      start:    _str(e && e.start, 30),
      end:      _str(e && e.end, 30),
      bullets:  _list(e && e.bullets, 8, 320),
    })).filter(e => e.title || e.company || e.bullets.length),
    education: (Array.isArray(r.education) ? r.education : []).slice(0, 6).map(e => ({
      degree:  _str(e && e.degree, 160),
      school:  _str(e && e.school, 160),
      year:    _str(e && e.year, 30),
      details: _str(e && e.details, 240),
    })).filter(e => e.degree || e.school),
    skills:         _list(r.skills, 30, 60),
    languages:      _list(r.languages, 8, 60),
    certifications: _list(r.certifications, 12, 160),
    projects: (Array.isArray(r.projects) ? r.projects : []).slice(0, 6).map(p => ({
      name:    _str(p && p.name, 140),
      bullets: _list(p && p.bullets, 5, 320),
    })).filter(p => p.name || p.bullets.length),
  };
}

function cvIsEmpty(cv) {
  return !cv || !(cv.summary || cv.experience.length || cv.education.length || cv.skills.length || cv.projects.length);
}

// Every text value in a CV, flattened (used by the no-invention guard and plain-text export).
function cvStrings(cv) {
  const out = [];
  if (!cv) return out;
  out.push(cv.name, cv.headline, cv.summary, cv.contact.email, cv.contact.phone, cv.contact.city, cv.contact.linkedin);
  for (const e of cv.experience) { out.push(e.title, e.company, e.location, e.start, e.end); out.push(...e.bullets); }
  for (const e of cv.education) out.push(e.degree, e.school, e.year, e.details);
  out.push(...cv.skills, ...cv.languages, ...cv.certifications);
  for (const p of cv.projects) { out.push(p.name); out.push(...p.bullets); }
  return out.filter(Boolean);
}

// ─── the no-invention guard ────────────────────────────────────────────────
// Numbers are language-independent, so they are the reliable check: a figure
// (a percentage, an amount, a year, a team size) that the person never wrote
// is an invention. Returns the unsupported numbers, deduped.
function numbersIn(text) {
  const t = toAsciiDigits(text).replace(/(\d)[,٬](\d{3})/g, '$1$2');
  return (t.match(/\d+(?:\.\d+)?/g) || []);
}
function findUnsupportedNumbers(cv, allowedText) {
  const allowed = new Set(numbersIn(allowedText));
  // A long number in the source (a phone, an id) also supports its own pieces.
  const allowedBlob = ' ' + Array.from(allowed).join(' ') + ' ';
  const bad = [];
  for (const s of cvStrings(cv)) {
    for (const n of numbersIn(s)) {
      if (n.length < 2 && !/%/.test(s)) continue;            // single digits (1 team, 3 tools) are noise
      if (allowed.has(n)) continue;
      if (n.length >= 4 && allowedBlob.indexOf(n) !== -1) continue;
      if (bad.indexOf(n) === -1) bad.push(n);
    }
  }
  return bad;
}

// Remove bullets that still carry an invented figure after the retry. The
// rest of the CV (which is supported) is kept.
function stripUnsupported(cv, allowedText) {
  const allowed = new Set(numbersIn(allowedText));
  const blob = ' ' + Array.from(allowed).join(' ') + ' ';
  const ok = (s) => numbersIn(s).every(n => (n.length < 2 && !/%/.test(s)) || allowed.has(n) || (n.length >= 4 && blob.indexOf(n) !== -1));
  let removed = 0;
  const keep = (arr) => arr.filter(s => { const k = ok(s); if (!k) removed++; return k; });
  for (const e of cv.experience) e.bullets = keep(e.bullets);
  for (const p of cv.projects) p.bullets = keep(p.bullets);
  if (cv.summary && !ok(cv.summary)) {
    const parts = cv.summary.split(/(?<=[.!؟?。])\s+/).filter(ok);
    removed++;
    cv.summary = parts.join(' ');
  }
  cv.certifications = keep(cv.certifications);
  return removed;
}

// ─── prompts ───────────────────────────────────────────────────────────────
const SCHEMA_TEXT = `{
  "cv": {
    "name": "", "headline": "",
    "contact": { "email": "", "phone": "", "city": "", "linkedin": "" },
    "summary": "",
    "experience": [ { "title": "", "company": "", "location": "", "start": "", "end": "", "bullets": [""] } ],
    "education": [ { "degree": "", "school": "", "year": "", "details": "" } ],
    "skills": [""], "languages": [""], "certifications": [""],
    "projects": [ { "name": "", "bullets": [""] } ]
  },
  "missing": ["short question in Arabic"]
}`;

function systemPrompt(lang) {
  const langRule = lang === 'en'
    ? 'Write the CV in clear professional English. If the source is Arabic, translate it faithfully; keep company and school names as the person wrote them (transliterate only when obvious).'
    : 'اكتب السيرة بعربية مهنية بسيطة ومحايدة (ابدأ النقاط بمصدر مثل: إدارة، تطوير، تحليل، تنسيق) بدون صيغة مذكر أو مؤنث. إذا كان المصدر إنجليزي ترجمه بأمانة، واترك أسماء الشركات والجامعات والأدوات كما كتبها صاحبها.';
  return [
    'You are the CV writer inside Darbi, an Arabic career app. You write a complete, stronger CV for the person from their own information.',
    'HARD RULES (never break them):',
    '1. Use ONLY facts found in the SOURCE and in the ANSWERS. Never add an employer, job title, date, degree, certificate, tool, skill, number, percentage, amount or achievement that is not there.',
    '2. If the source has no numbers for an achievement, write it without numbers. Never estimate.',
    '3. When something important is missing (dates of a job, employer name, graduation year, a measurable result, contact details), do NOT guess: leave that field empty and add ONE short Arabic question about it to "missing" (at most 4 questions, the most valuable first).',
    '4. Rephrase and structure: strong action wording, one idea per bullet, at most 22 words per bullet, most relevant to the goal first. Merge duplicates. Fix spelling.',
    '5. ATS-friendly: plain text only, standard section content, no emojis, no tables, no first-person pronouns.',
    '6. The summary is 2 to 3 sentences that position the person for the GOAL and TARGET ROLE using only supported facts.',
    '7. "skills" contains only skills and tools the person mentioned or clearly demonstrated in their own text.',
    langRule,
    'Return JSON only, exactly in this shape (empty string or empty array when unknown):',
    SCHEMA_TEXT,
  ].join('\n');
}

function goalLine(goal, lang) {
  const g = GOALS[goal] || GOALS.target_role;
  return lang === 'en' ? g.en : g.ar;
}

function userPrompt(input, lang, extra) {
  const lines = [
    'GOAL: ' + goalLine(input.goal, 'en') + ' (' + goalLine(input.goal, 'ar') + ')',
    'TARGET ROLE: ' + (input.targetRole || '(not given)'),
    'COUNTRY OF THE JOB SEARCH: ' + (input.country || '(not given)'),
    'OUTPUT LANGUAGE: ' + (lang === 'en' ? 'English' : 'Arabic'),
    '',
    'SOURCE (the person\'s own CV text / notes):',
    '"""',
    input.sourceText,
    '"""',
  ];
  if (input.answersText) lines.push('', 'ANSWERS the person gave to earlier questions:', '"""', input.answersText, '"""');
  if (extra) lines.push('', extra);
  return lines.join('\n');
}

// ─── input cleaning ────────────────────────────────────────────────────────
function cleanInput(body) {
  const b = body || {};
  const goal = GOALS[b.goal] ? b.goal : 'target_role';
  let langs = Array.isArray(b.languages) ? b.languages : (b.language === 'both' ? ['ar', 'en'] : [b.language]);
  langs = langs.filter(l => l === 'ar' || l === 'en');
  if (!langs.length) langs = ['ar'];
  const answers = Array.isArray(b.answers) ? b.answers : [];
  const answersText = answers
    .map(a => (a && a.answer && String(a.answer).trim()) ? ('Q: ' + _str(a.question, 200) + '\nA: ' + _str(a.answer, 500)) : '')
    .filter(Boolean).slice(0, 12).join('\n');
  return {
    goal,
    targetRole: _str(b.targetRole, 120),
    country:    _str(b.country, 60),
    langs:      Array.from(new Set(langs)),
    sourceText: String(b.sourceText || '').replace(/\r/g, '').trim().slice(0, 9000),
    answersText,
  };
}

// ─── non-AI fallback ───────────────────────────────────────────────────────
// A tidy structured copy of the person's own lines. No rewriting, no additions.
// A heading is a whole short line (JS \b does not work after Arabic letters).
const HEAD_RE = [
  ['experience', /^(?:experience|work experience|employment|professional experience|الخبرات?|الخبرة العملية|الخبرات العملية|خبراتي)\s*[:：-]?\s*$/i],
  ['education', /^(?:education|academic|التعليم|المؤهلات?|الدراسة|المؤهل العلمي)\s*[:：-]?\s*$/i],
  ['skills', /^(?:skills|technical skills|المهارات?|مهاراتي)\s*[:：-]?\s*$/i],
  ['languages', /^(?:languages|اللغات?)\s*[:：-]?\s*$/i],
  ['certifications', /^(?:certifications?|certificates|courses|الشهادات?|الدورات?)\s*[:：-]?\s*$/i],
  ['projects', /^(?:projects|المشاريع|مشاريعي)\s*[:：-]?\s*$/i],
  ['summary', /^(?:summary|profile|objective|about|الملخص|نبذة|الهدف|عني)\s*[:：-]?\s*$/i],
];
function fallbackCv(input) {
  const lines = input.sourceText.split('\n').map(l => l.replace(/^[\s•\-–*·▪●]+/, '').trim()).filter(Boolean);
  const text = input.sourceText;
  const email = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [''])[0];
  const phone = (toAsciiDigits(text).match(/(?:\+|00)?\d[\d\s-]{7,14}\d/) || [''])[0].trim();
  const linkedin = (text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[^\s,;]+/i) || [''])[0];
  const cv = normalizeCv({});
  cv.contact.email = email; cv.contact.phone = phone; cv.contact.linkedin = linkedin;
  let section = 'intro';
  const buckets = { intro: [], summary: [], experience: [], education: [], skills: [], languages: [], certifications: [], projects: [] };
  for (const line of lines) {
    const head = HEAD_RE.find(h => h[1].test(line) && line.length <= 40);
    if (head) { section = head[0]; continue; }
    buckets[section].push(line);
  }
  const isContact = (l) => (email && l.includes(email)) || (phone && toAsciiDigits(l).includes(phone)) || /linkedin\.com/i.test(l);
  const intro = buckets.intro.filter(l => !isContact(l));
  if (intro.length && intro[0].length <= 60 && !/\d{3,}/.test(intro[0])) cv.name = intro.shift();
  cv.summary = buckets.summary.concat(buckets.summary.length ? [] : intro.splice(0, 2)).join(' ').slice(0, 900);
  const expLines = buckets.experience.concat(intro);
  if (expLines.length) cv.experience = [{ title: '', company: '', location: '', start: '', end: '', bullets: expLines.slice(0, 8).map(l => l.slice(0, 320)) }];
  if (expLines.length > 8) cv.experience.push({ title: '', company: '', location: '', start: '', end: '', bullets: expLines.slice(8, 16).map(l => l.slice(0, 320)) });
  cv.education = buckets.education.slice(0, 6).map(l => ({ degree: l.slice(0, 160), school: '', year: '', details: '' }));
  cv.skills = buckets.skills.join('، ').split(/[،,;|·•]/).map(s => s.trim()).filter(Boolean).slice(0, 30).map(s => s.slice(0, 60));
  cv.languages = buckets.languages.join('، ').split(/[،,;|·•]/).map(s => s.trim()).filter(Boolean).slice(0, 8);
  cv.certifications = buckets.certifications.slice(0, 12).map(l => l.slice(0, 160));
  if (buckets.projects.length) cv.projects = [{ name: '', bullets: buckets.projects.slice(0, 5).map(l => l.slice(0, 320)) }];
  cv.headline = input.targetRole || '';
  return cv;
}

const FALLBACK_LABEL = 'نسخة مرتّبة بدون ذكاء اصطناعي: رتّبنا كلامك في أقسام كما كتبته، بدون إعادة صياغة. الكتابة بالذكاء الاصطناعي غير متاحة الحين.';

// ─── generate ──────────────────────────────────────────────────────────────
// deps.chat(messages, opts) -> parsed JSON object (throws on failure). null = AI not configured.
async function generateCv(body, deps) {
  const input = cleanInput(body);
  if (input.sourceText.length < 40) {
    return { success: false, error: 'source_too_short',
      message: 'اكتب أو الصق معلوماتك أول: تعليمك، خبراتك أو تدريبك، ومهاراتك. نكتب السيرة من كلامك فقط.' };
  }
  const rec = recommendTemplate(input.goal);
  const base = { success: true, goal: input.goal, templates: TEMPLATES, recommendedTemplate: rec.template, recommendReason: rec.reason };
  const chat = deps && deps.chat;
  const allowed = input.sourceText + '\n' + input.answersText + '\n' + input.targetRole;

  if (!chat) {
    return Object.assign(base, { ai: false, label: FALLBACK_LABEL, cv: { [input.langs[0]]: fallbackCv(input) }, languages: [input.langs[0]], missing: [], warnings: [] });
  }

  const out = {};
  let missing = [];
  let removedTotal = 0;
  try {
    await Promise.all(input.langs.map(async (lang) => {
      const messages = [
        { role: 'system', content: systemPrompt(lang) },
        { role: 'user', content: userPrompt(input, lang) },
      ];
      let res = await chat(messages, { max_tokens: 2600, temperature: 0.2 });
      let cv = normalizeCv(res && res.cv);
      let bad = findUnsupportedNumbers(cv, allowed);
      if (bad.length) {
        // One corrective retry, naming the invented figures.
        const retry = messages.concat([
          { role: 'assistant', content: JSON.stringify({ cv }) },
          { role: 'user', content: 'These numbers are NOT in the source or answers, so they are invented: ' + bad.join(', ') + '. Rewrite the same CV without them (keep the sentences, drop the unsupported figures). Return the full JSON again.' },
        ]);
        res = await chat(retry, { max_tokens: 2600, temperature: 0 });
        cv = normalizeCv(res && res.cv);
        bad = findUnsupportedNumbers(cv, allowed);
        if (bad.length) removedTotal += stripUnsupported(cv, allowed);
      }
      if (cvIsEmpty(cv)) throw new Error('empty_cv');
      out[lang] = cv;
      if (lang === input.langs[0]) missing = _list(res && res.missing, 4, 200);
    }));
  } catch (e) {
    if (deps && deps.onError) deps.onError(e);
    return Object.assign(base, { ai: false, aiFailed: true, label: FALLBACK_LABEL, cv: { [input.langs[0]]: fallbackCv(input) }, languages: [input.langs[0]], missing: [], warnings: [] });
  }
  const warnings = removedTotal
    ? ['حذفنا ' + removedTotal + ' سطر فيه أرقام ما لقيناها في كلامك. لو الرقم صحيح اكتبه لنا ونضيفه.']
    : [];
  return Object.assign(base, { ai: true, cv: out, languages: input.langs, missing, warnings });
}

// ─── edit with the assistant ───────────────────────────────────────────────
// «غيّر هالسطر»، «خله أقصر»: applies the person's instruction to the CV. New
// facts typed in the instruction are theirs, so they are allowed.
async function editCv(body, deps) {
  const b = body || {};
  const lang = b.lang === 'en' ? 'en' : 'ar';
  const instruction = _str(b.instruction, 600);
  const cv = normalizeCv(b.cv);
  if (!instruction) return { success: false, error: 'missing_instruction', message: 'اكتب وش تبي نغيّر.' };
  if (cvIsEmpty(cv)) return { success: false, error: 'missing_cv', message: 'ما فيه سيرة نعدّلها. اكتب سيرتك أول.' };
  const chat = deps && deps.chat;
  if (!chat) {
    return { success: false, ai: false, error: 'assistant_unavailable',
      message: 'التعديل بالمساعد غير متاح الحين. تقدر تعدّل أي سطر بنفسك من زر «عدّل».' };
  }
  const sourceText = String(b.sourceText || '').slice(0, 9000);
  const allowed = sourceText + '\n' + instruction + '\n' + cvStrings(cv).join('\n');
  const messages = [
    { role: 'system', content: [
      'You edit a CV inside Darbi, an Arabic career app. Apply the person\'s instruction to the CV JSON.',
      'Rules: change only what the instruction asks and keep everything else exactly as it is. Never add facts, numbers, employers, tools or achievements that are not already in the CV, unless the person states them in the instruction itself (then they are their own facts and you add them as written).',
      'If the instruction is unclear or asks to invent experience, change nothing and explain in "note".',
      lang === 'en' ? 'Keep the CV in English.' : 'أبقِ السيرة بالعربية المهنية البسيطة المحايدة.',
      'Return JSON only: { "cv": <the full CV in the same shape>, "note": "one short Arabic sentence saying what changed" }',
    ].join('\n') },
    { role: 'user', content: 'INSTRUCTION: ' + instruction + '\n\nCV JSON:\n' + JSON.stringify(cv) },
  ];
  try {
    const res = await chat(messages, { max_tokens: 2600, temperature: 0.2 });
    const next = normalizeCv(res && res.cv);
    if (cvIsEmpty(next)) throw new Error('empty_cv');
    const removed = findUnsupportedNumbers(next, allowed).length ? stripUnsupported(next, allowed) : 0;
    const changed = JSON.stringify(next) !== JSON.stringify(cv);
    return {
      success: true, ai: true, cv: next, changed,
      note: _str(res && res.note, 240) || (changed ? 'تم التعديل.' : 'ما غيّرنا شي. وضّح طلبك أكثر.'),
      warnings: removed ? ['حذفنا ' + removed + ' سطر فيه أرقام ما كتبتها أنت.'] : [],
    };
  } catch (e) {
    if (deps && deps.onError) deps.onError(e);
    return { success: false, ai: false, error: 'assistant_failed',
      message: 'ما قدرنا ننفّذ التعديل الحين. جرّب بعد شوي، أو عدّل السطر بنفسك من زر «عدّل».' };
  }
}

// ─── Express routes ────────────────────────────────────────────────────────
// Public with tight limits (the CV preview is free and needs no account);
// signed-in people get a higher allowance keyed on their account.
function register(app, deps) {
  const { rateLimit, getIP, optionalUser, safeAiErrorSummary } = deps;

  function chatFactory() {
    if (!process.env.OPENAI_API_KEY) return null;
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return async (messages, opts) => {
      const r = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages,
        response_format: { type: 'json_object' },
        max_tokens: (opts && opts.max_tokens) || 2000,
        temperature: (opts && typeof opts.temperature === 'number') ? opts.temperature : 0.2,
      });
      return JSON.parse(r.choices[0].message.content);
    };
  }
  const onError = (e) => console.error('[cv-writer] AI error:', safeAiErrorSummary ? safeAiErrorSummary(e) : (e && e.message));

  function allow(req, kind, guestMax, userMax) {
    const user = optionalUser ? optionalUser(req) : null;
    const key = user ? ('cvw-' + kind + ':u' + user.id) : ('cvw-' + kind + ':ip' + getIP(req));
    return rateLimit(key, user ? userMax : guestMax, 3600_000);
  }

  app.get('/api/darbi/cv/templates', (req, res) => {
    res.json({ success: true, templates: TEMPLATES, goals: GOALS, aiAvailable: !!process.env.OPENAI_API_KEY });
  });

  app.post('/api/darbi/cv/generate', async (req, res) => {
    if (!allow(req, 'gen', 4, 15)) {
      return res.status(429).json({ success: false, error: 'rate_limit', message: 'وصلت حد المحاولات لهذي الساعة. جرّب بعد شوي.' });
    }
    try {
      const result = await generateCv(req.body, { chat: chatFactory(), onError });
      res.status(result.success === false ? 400 : 200).json(result);
    } catch (e) {
      onError(e);
      res.status(500).json({ success: false, error: 'cv_generate_failed', message: 'ما قدرنا نكتب السيرة الحين. حاول بعد شوي.' });
    }
  });

  app.post('/api/darbi/cv/edit', async (req, res) => {
    if (!allow(req, 'edit', 10, 40)) {
      return res.status(429).json({ success: false, error: 'rate_limit', message: 'وصلت حد التعديلات لهذي الساعة. جرّب بعد شوي.' });
    }
    try {
      const result = await editCv(req.body, { chat: chatFactory(), onError });
      res.status(result.success === false && /^missing_/.test(result.error || '') ? 400 : 200).json(result);
    } catch (e) {
      onError(e);
      res.status(500).json({ success: false, error: 'cv_edit_failed', message: 'ما قدرنا ننفّذ التعديل الحين. حاول بعد شوي.' });
    }
  });
}

module.exports = {
  GOALS, TEMPLATES, FALLBACK_LABEL,
  recommendTemplate, normalizeCv, cvIsEmpty, cvStrings,
  numbersIn, findUnsupportedNumbers, stripUnsupported,
  cleanInput, fallbackCv, generateCv, editCv, register,
  systemPrompt, userPrompt, toAsciiDigits,
};
