// Legal pages (Terms / Privacy / Refund / Contact). Operator: inventive gaze, LLC.
// Prices mirror the pricing screen in public/v2.html and PLANS in server/index.js.
const EMAIL = 'hala@inab.app';
const UPDATED = '22 نوفمبر 2026';
const BASE = (process.env.APP_URL || 'https://darbi-production.up.railway.app').replace(/\/$/, '');

function shell(title, desc, path, body) {
  return `<!doctype html><html lang="ar" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — دربي</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${BASE}${path}">
<style>
body{margin:0;background:#f8fafc;color:#0f172a;font-family:system-ui,-apple-system,'Segoe UI',Tahoma,sans-serif;line-height:1.9}
.wrap{max-width:760px;margin:0 auto;padding:24px 18px 56px}
a{color:#4f46e5}.brand{font-weight:800;font-size:20px;text-decoration:none;color:#0f172a}
h1{font-size:28px;margin:18px 0 4px}h2{font-size:18px;margin:0 0 6px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:16px 20px;margin:12px 0}
.card p,.card li{font-size:15px;margin:6px 0}.card ul{margin:6px 0;padding-inline-start:20px}
.muted{color:#64748b;font-size:13px}.nav{margin-top:20px;font-size:13px;display:flex;gap:14px;flex-wrap:wrap}
</style></head><body><div class="wrap">
<a class="brand" href="/">دربي</a>
<h1>${title}</h1><p class="muted">آخر تحديث: ${UPDATED}</p>
${body}
<p class="muted">يُشغّل هذا المنتج من قبل inventive gaze, LLC — الدعم: <a href="mailto:${EMAIL}">${EMAIL}</a></p>
<div class="nav"><a href="/terms">الشروط</a><a href="/privacy">الخصوصية</a><a href="/terms#refund">الاسترداد والإلغاء</a><a href="/terms#contact">تواصل معنا</a><a href="/">الرئيسية</a></div>
</div></body></html>`;
}
const sec = (id, h, inner) => `<div class="card"${id ? ` id="${id}"` : ''}><h2>${h}</h2>${inner}</div>`;

const TERMS = [
  sec('', '1. قبول الشروط', '<p>باستخدامك لدربي توافق على هذه الشروط. إذا ما توافق عليها، لا تستخدم الخدمة.</p>'),
  sec('', '2. وش هو دربي', '<p>دربي أداة مساعدة للباحثين عن عمل: تشخّص لك وين المشكلة في تقديماتك، وتجهّز لك تقديمًا لكل وظيفة، وتدرّبك على المقابلات، وتتابع تقديماتك. الوظائف المعروضة من لوحات توظيف عامة ومرتبطة بصفحاتها الأصلية. ما نضمن وظيفة ولا رد من أي شركة.</p>'),
  sec('', '3. الحساب', '<p>تحتاج حساب (بريد وكلمة مرور) لاستخدام دربي. أنت مسؤول عن سرية دخولك وعن صحة المعلومات اللي تدخلها، ومسؤول عن مراجعة أي نص يجهّزه دربي قبل ما ترسله لأي جهة.</p>'),
  sec('', '4. الباقات والدفع', '<ul><li>الأسعار بالدولار الأمريكي: Starter ‏9$ شهريًا أو ‏84$ سنويًا، Pro ‏19$ شهريًا أو ‏180$ سنويًا. التفاصيل في صفحة الأسعار داخل التطبيق.</li><li>الدفع إلكتروني ببطاقة عن طريق Stripe. ما نحفظ بيانات بطاقتك عندنا.</li><li>الاشتراك الشهري يتجدد تلقائيًا كل شهر بنفس السعر لين تلغيه.</li><li>الاشتراك السنوي يتجدد تلقائيًا كل سنة بنفس السعر لين تلغيه.</li><li>باقة Founder (دفعة وحدة) ما عادت تُباع، ومن اشتراها سابقًا يبقى وصوله كما هو.</li></ul>'),
  sec('', '5. التجربة المجانية', '<p>التشخيص المجاني وأول تقديم مجانًا وبدون بطاقة. ما ينسحب منك أي مبلغ إلا إذا اخترت باقة ودفعت بنفسك.</p>'),
  sec('', '6. الإلغاء', '<ul><li>تقدر تلغي اشتراكك الشهري متى ما بغيت من «حسابي ← إدارة الاشتراك» أو بإيميل لـ ' + EMAIL + '.</li><li>بعد الإلغاء يظل حسابك شغال لين نهاية الفترة المدفوعة، وما يتجدد بعدها.</li></ul>'),
  sec('refund', '7. سياسة الاسترداد', '<ul><li>الاشتراك الشهري أو السنوي: استرداد كامل لأول دفعة إذا طلبته خلال 7 أيام من الدفع. بعدها ما فيه استرداد للفترة الجارية، ويوقف التجديد الجاي.</li><li>من اشترى باقة Founder سابقًا (مدى الحياة): استرداد كامل إذا طلبه خلال 14 يوم من الشراء.</li><li>الاسترداد يرجع لنفس البطاقة خلال 5–10 أيام عمل حسب البنك.</li><li>لطلب الاسترداد: إيميل لـ ' + EMAIL + ' فيه بريد حسابك.</li></ul>'),
  sec('', '8. الاستخدام المقبول', '<p>لا تستخدم دربي لتزوير خبرات أو شهادات، ولا لإرسال رسائل مزعجة، ولا لأي نشاط مخالف للأنظمة. يحق لنا إيقاف أي حساب يخالف هذا.</p>'),
  sec('', '9. البيانات والخصوصية', '<p>بياناتك لك. نستخدمها فقط لتشغيل الخدمة ولا نبيعها. التفاصيل في <a href="/privacy">سياسة الخصوصية</a>.</p>'),
  sec('', '10. حدود المسؤولية', '<p>نقدم الخدمة كما هي ونسعى أن تكون متاحة دائمًا، لكن ما نضمن نتائج توظيف معينة. مسؤوليتنا في أي حال لا تتجاوز المبلغ اللي دفعته لنا خلال آخر 3 أشهر.</p>'),
  sec('contact', '11. التواصل', '<p>يُشغّل هذا المنتج من قبل inventive gaze, LLC (ديلاوير، الولايات المتحدة).</p><p>الإيميل: <a href="mailto:' + EMAIL + '">' + EMAIL + '</a> — نرد خلال يوم عمل.</p>'),
].join('');

const PRIVACY = [
  sec('', '1. المقدمة', '<p>دربي يُشغّله inventive gaze, LLC. توضح هذه السياسة وش نجمع من بياناتك وكيف نستخدمه.</p>'),
  sec('', '2. وش نجمع', '<ul><li>بريدك وكلمة مرور مشفّرة.</li><li>نص سيرتك وتشخيصك وتقديماتك ونتائج تدريبك: تُحفظ في حسابك لما تسجّل دخول عشان تلقاها على أي جهاز، وتبقى نسخة منها على جهازك. بدون حساب تبقى على جهازك فقط.</li><li>بيانات الدفع تُعالج عند Stripe ولا نحفظ بيانات البطاقة.</li></ul>'),
  sec('', '3. كيف نستخدمها', '<p>نستخدم بياناتك فقط لتشغيل الخدمة. يُرسل نص السيرة أو إجابات التدريب لخدمة الذكاء الاصطناعي لتحليلها فقط. ما نبيع بياناتك ولا نشاركها مع أحد إلا مزودي الخدمة اللازمين للتشغيل (استضافة، ذكاء اصطناعي، دفع).</p>'),
  sec('', '4. حقوقك', '<p>لك الحق في الوصول إلى بياناتك وتصحيحها وحذفها (وحذف حسابك). راسلنا على ' + EMAIL + '.</p>'),
  sec('', '5. الاتصال بنا', '<p><a href="mailto:' + EMAIL + '">' + EMAIL + '</a></p>'),
].join('');

function mount(app) {
  app.get('/terms', (req, res) => res.type('html').send(shell('شروط الخدمة', 'شروط استخدام دربي: الباقات والدفع والإلغاء والاسترداد.', '/terms', TERMS)));
  app.get('/privacy', (req, res) => res.type('html').send(shell('سياسة الخصوصية', 'كيف يتعامل دربي مع بياناتك، وحقك في الوصول والتصحيح والحذف.', '/privacy', PRIVACY)));
  app.get('/refund', (req, res) => res.redirect(301, '/terms#refund'));
  app.get('/contact', (req, res) => res.redirect(301, '/terms#contact'));
}
module.exports = { mount };
