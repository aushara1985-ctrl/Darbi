// ══════ Geo helper — GCC countries + cities (Arabic + English) ═════════════
// Pure, no I/O. Used by searchProfile (normalise what the user picked),
// ranker (location fit) and jobs/index.js (honest fallback links + country filter).
// Saudi cities first, then the other GCC countries.

const COUNTRIES = [
  { code: 'SA', ar: 'السعودية',  en: 'Saudi Arabia', alias: ['saudi', 'ksa', 'kingdom of saudi', 'السعودية', 'المملكة العربية السعودية'] },
  { code: 'AE', ar: 'الإمارات',  en: 'United Arab Emirates', alias: ['uae', 'united arab emirates', 'emirates', 'الامارات', 'الإمارات'] },
  { code: 'KW', ar: 'الكويت',    en: 'Kuwait',  alias: ['kuwait', 'الكويت'] },
  { code: 'QA', ar: 'قطر',       en: 'Qatar',   alias: ['qatar', 'قطر'] },
  { code: 'BH', ar: 'البحرين',   en: 'Bahrain', alias: ['bahrain', 'البحرين'] },
  { code: 'OM', ar: 'عُمان',     en: 'Oman',    alias: ['oman', 'عمان', 'عُمان', 'سلطنة عمان'] },
];

const CITIES = [
  // Saudi Arabia
  { c: 'SA', ar: 'الرياض', en: 'Riyadh' },
  { c: 'SA', ar: 'جدة', en: 'Jeddah' },
  { c: 'SA', ar: 'مكة المكرمة', en: 'Makkah', alias: ['mecca', 'makkah', 'مكه'] },
  { c: 'SA', ar: 'المدينة المنورة', en: 'Madinah', alias: ['medina', 'madinah', 'al madinah', 'المدينه'] },
  { c: 'SA', ar: 'الدمام', en: 'Dammam' },
  { c: 'SA', ar: 'الخبر', en: 'Khobar', alias: ['al khobar', 'alkhobar'] },
  { c: 'SA', ar: 'الظهران', en: 'Dhahran' },
  { c: 'SA', ar: 'الجبيل', en: 'Jubail' },
  { c: 'SA', ar: 'الأحساء', en: 'Al Ahsa', alias: ['hofuf', 'al hasa', 'الاحساء'] },
  { c: 'SA', ar: 'القطيف', en: 'Qatif' },
  { c: 'SA', ar: 'الطائف', en: 'Taif' },
  { c: 'SA', ar: 'تبوك', en: 'Tabuk' },
  { c: 'SA', ar: 'أبها', en: 'Abha', alias: ['ابها'] },
  { c: 'SA', ar: 'خميس مشيط', en: 'Khamis Mushait' },
  { c: 'SA', ar: 'بريدة', en: 'Buraydah', alias: ['buraidah'] },
  { c: 'SA', ar: 'حائل', en: 'Hail', alias: ['ha il'] },
  { c: 'SA', ar: 'جازان', en: 'Jazan', alias: ['jizan'] },
  { c: 'SA', ar: 'نجران', en: 'Najran' },
  { c: 'SA', ar: 'ينبع', en: 'Yanbu' },
  { c: 'SA', ar: 'الباحة', en: 'Al Baha', alias: ['albaha'] },
  { c: 'SA', ar: 'سكاكا', en: 'Sakaka' },
  { c: 'SA', ar: 'عرعر', en: 'Arar' },
  // UAE
  { c: 'AE', ar: 'دبي', en: 'Dubai' },
  { c: 'AE', ar: 'أبوظبي', en: 'Abu Dhabi', alias: ['ابوظبي'] },
  { c: 'AE', ar: 'الشارقة', en: 'Sharjah' },
  { c: 'AE', ar: 'عجمان', en: 'Ajman' },
  { c: 'AE', ar: 'رأس الخيمة', en: 'Ras Al Khaimah' },
  // Kuwait / Qatar / Bahrain / Oman
  { c: 'KW', ar: 'مدينة الكويت', en: 'Kuwait City', alias: ['kuwait city'] },
  { c: 'QA', ar: 'الدوحة', en: 'Doha' },
  { c: 'BH', ar: 'المنامة', en: 'Manama' },
  { c: 'OM', ar: 'مسقط', en: 'Muscat' },
];

function _n(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ـ/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

const REMOTE_RE = /remote|work from home|wfh|hybrid anywhere|عن بعد|انترنت/;

// Well-known non-GCC places: a job there is clearly not local for a Gulf seeker.
const OTHER_RE = /(^| )(egypt|cairo|alexandria|jordan|amman|lebanon|beirut|pakistan|karachi|india|bangalore|london|united kingdom|uk|usa|united states|germany|berlin|turkey|istanbul|morocco|casablanca|nigeria|lagos|singapore)( |$)/;

function _country(code) { return COUNTRIES.find(c => c.code === code) || null; }

function _cityTokens(city) {
  return [city.en, city.ar].concat(city.alias || []).map(_n).filter(Boolean);
}

// Does normalised text contain token as a whole word / phrase?
function _has(text, token) {
  if (!token) return false;
  return (' ' + text + ' ').indexOf(' ' + token + ' ') !== -1;
}

// Turn whatever the user typed/picked ("الرياض", "Riyadh, Saudi Arabia", "Dubai",
// "عن بعد") into a canonical object. Unknown free text is kept as a label only.
function resolveLocation(input) {
  const raw = (input && typeof input === 'object')
    ? [input.city, input.country].filter(Boolean).join(' ')
    : String(input || '');
  const t = _n(raw);
  if (!t) return null;
  if (REMOTE_RE.test(t)) return { remote: true, country: null, cityEn: null, cityAr: null, label: 'Remote', labelEn: 'Remote' };
  let city = null;
  for (const c of CITIES) {
    if (_cityTokens(c).some(tok => _has(t, tok))) { city = c; break; }
  }
  let country = city ? _country(city.c) : null;
  if (!country) {
    country = COUNTRIES.find(c => [c.en, c.ar].concat(c.alias || []).map(_n).some(tok => _has(t, tok))) || null;
  }
  const cityEn = city ? city.en : null;
  const labelEn = [cityEn, country ? country.en : null].filter(Boolean).join(', ') || raw.trim();
  return {
    remote: false,
    country: country ? country.code : null,
    countryEn: country ? country.en : null,
    countryAr: country ? country.ar : null,
    cityEn,
    cityAr: city ? city.ar : null,
    label: labelEn,
    labelEn,
  };
}

// How does a job's free-text location relate to the user's resolved location?
//   'city'    — same city
//   'country' — same country, other/unknown city
//   'remote'  — remote role
//   'other'   — clearly another GCC country/city
//   'unknown' — job gave no usable location
function jobLocationRelation(jobLocation, resolved) {
  const t = _n(jobLocation);
  if (!t) return 'unknown';
  if (REMOTE_RE.test(t)) return 'remote';
  if (!resolved || resolved.remote) return 'unknown';
  // Find the job's own city/country.
  let jCity = null;
  for (const c of CITIES) if (_cityTokens(c).some(tok => _has(t, tok))) { jCity = c; break; }
  let jCountry = jCity ? jCity.c : null;
  if (!jCountry) {
    const hit = COUNTRIES.find(c => [c.en, c.ar].concat(c.alias || []).map(_n).some(tok => _has(t, tok)));
    jCountry = hit ? hit.code : null;
  }
  if (!jCountry && !jCity) return OTHER_RE.test(t) ? 'other' : 'unknown';
  if (resolved.cityEn && jCity && jCity.en === resolved.cityEn) return 'city';
  // Multi-location strings ("Riyadh, Dubai") — match if ANY listed place is the user's.
  if (resolved.cityEn && CITIES.some(c => c.en === resolved.cityEn && _cityTokens(c).some(tok => _has(t, tok)))) return 'city';
  if (resolved.country && jCountry === resolved.country) return 'country';
  if (resolved.country && COUNTRIES.some(c => c.code === resolved.country && [c.en, c.ar].concat(c.alias || []).map(_n).some(tok => _has(t, tok)))) return 'country';
  return 'other';
}

module.exports = { COUNTRIES, CITIES, resolveLocation, jobLocationRelation };
