// ══════ Job ranker — turns a job list + profile into a scored, sorted list ═
// Pure functions, no I/O. Scoring rubric (max 100):
//   30 seniority fit
//   25 title/dream fit
//   20 skills/keywords fit
//   10 industry/company fit
//   10 location fit
//    5 readiness fit
//   - up to -30 penalties from avoidTitles / clear mismatches
//
// Risk flags surface "this job is likely wrong for you, here's why" — used
// by the UI to show "أقل من مستواك" / "أعلى من مرحلتك" etc.

const SENIORITY_RANK = {
  fresh_grad: 0,
  junior:     1,
  mid:        2,
  senior:     3,
  senior_leadership: 4,
};

function _norm(s) { return (s || '').toLowerCase(); }

function _titleSeniority(title) {
  const t = _norm(title);
  if (/\b(vp|vice president|chief|cxo|cco|cmo|coo|cto|ceo|cfo|head of|director)\b/.test(t)) return 'senior_leadership';
  if (/\b(senior|sr\.?|principal|staff|lead)\b/.test(t)) return 'senior';
  if (/\b(manager|mgr)\b/.test(t)) return 'mid'; // could be senior — keep conservative
  if (/\b(junior|jr\.?|associate|trainee|intern)\b/.test(t)) return 'fresh_grad';
  return 'mid';
}

function _hasAny(haystack, needles) {
  const h = _norm(haystack);
  for (const n of (needles || [])) {
    const nn = _norm(n);
    if (nn && h.indexOf(nn) !== -1) return n;
  }
  return null;
}

function _wordIncludes(haystack, needle) {
  if (!haystack || !needle) return false;
  return _norm(haystack).indexOf(_norm(needle)) !== -1;
}

function _seniorityFit(jobTitle, profileLevel) {
  const j = _titleSeniority(jobTitle);
  const a = SENIORITY_RANK[j];
  const b = SENIORITY_RANK[profileLevel] != null ? SENIORITY_RANK[profileLevel] : 2;
  const diff = Math.abs(a - b);
  if (diff === 0) return 30;
  if (diff === 1) return 18;
  if (diff === 2) return 6;
  return 0;
}

function _titleFit(jobTitle, profile) {
  const t = _norm(jobTitle);
  // Direct hit on a target title → near-max.
  for (const tt of profile.targetTitles || []) {
    if (_norm(tt) === t) return 25;
    if (t.indexOf(_norm(tt)) !== -1 || _norm(tt).indexOf(t) !== -1) return 22;
  }
  // Family search keyword hit.
  for (const kw of profile.searchKeywords || []) {
    if (t.indexOf(_norm(kw)) !== -1) return 16;
  }
  // Dream-role substring fallback.
  if (profile.dreamRole && t.indexOf(_norm(profile.dreamRole)) !== -1) return 12;
  return 0;
}

function _skillsFit(job, profile) {
  const blob = _norm((job.title || '') + ' ' + (job.descriptionSnippet || job.description || '') + ' ' + (job.department || ''));
  let hits = 0;
  for (const k of (profile.mustHaveKeywords || [])) { if (k && blob.indexOf(_norm(k)) !== -1) hits++; }
  for (const k of (profile.niceToHaveKeywords || [])) { if (k && blob.indexOf(_norm(k)) !== -1) hits++; }
  if (hits === 0) return 0;
  if (hits === 1) return 6;
  if (hits === 2) return 12;
  if (hits === 3) return 17;
  return 20;
}

function _industryFit(job, profile) {
  if (!profile.industry) return 0;
  const blob = _norm((job.company || '') + ' ' + (job.descriptionSnippet || '') + ' ' + (job.department || ''));
  return blob.indexOf(_norm(profile.industry)) !== -1 ? 10 : 0;
}

function _locationFit(job, profile) {
  if (!profile.location) return 5; // neutral — no preference
  const loc = _norm(job.location);
  if (!loc) return 3;
  const want = _norm(profile.location);
  if (loc.indexOf(want) !== -1 || want.indexOf(loc) !== -1) return 10;
  // Remote earns half-credit when user has no remote pref.
  if (/remote|work from home|انترنت|عن بعد/.test(loc)) return 6;
  return 0;
}

function _readinessFit(job, profile) {
  // Light bias: if the job title matches a target title AND seniority is
  // aligned, bump readiness.
  const j = _titleSeniority(job.title);
  const aligned = (j === profile.seniorityLevel);
  return aligned ? 5 : 2;
}

function _penalty(job, profile) {
  const t = _norm(job.title);
  let pen = 0;
  const flags = [];
  // Avoid-title check — heaviest penalty.
  const hit = _hasAny(t, profile.avoidTitles);
  if (hit) {
    pen += 25;
    flags.push({ key: 'avoid_title', ar: 'هذا الدور غالباً غير مناسب لمستواك الحالي', token: hit });
  }
  // Seniority mismatch flags
  const j = _titleSeniority(job.title);
  const dJ = SENIORITY_RANK[j];
  const dP = SENIORITY_RANK[profile.seniorityLevel];
  if (dJ != null && dP != null) {
    if (dJ < dP - 1) {
      pen += 8;
      flags.push({ key: 'below_level', ar: 'أقل من مستواك الحالي' });
    } else if (dJ > dP + 1) {
      pen += 10;
      flags.push({ key: 'above_level', ar: 'أعلى من مرحلتك الحالية' });
    }
  }
  // Location penalty (non-blocking)
  if (profile.location && job.location) {
    const want = _norm(profile.location);
    const loc  = _norm(job.location);
    if (!want.split(/[,\s]+/).some(token => token && loc.indexOf(token) !== -1)) {
      // mild penalty when nothing overlaps — don't fully disqualify
      pen += 3;
      flags.push({ key: 'far_location', ar: 'المدينة قد لا تناسبك' });
    }
  }
  // Cap to -30 per spec.
  if (pen > 30) pen = 30;
  return { penalty: pen, flags };
}

function _whyMatched(job, profile, breakdown) {
  const reasons = [];
  if (breakdown.title >= 20) reasons.push('العنوان يطابق هدفك تقريبًا');
  else if (breakdown.title >= 12) reasons.push('العنوان قريب من هدفك');
  if (breakdown.seniority >= 18) reasons.push('مستواك يطابق متطلب الدور');
  if (breakdown.skills >= 12)    reasons.push('مهاراتك تظهر في وصف الدور');
  if (breakdown.location >= 6)   reasons.push('المدينة مناسبة لك');
  if (!reasons.length)           reasons.push('قريب من مسارك العام');
  return reasons.slice(0, 3);
}

function _cvFixTip(job, profile, breakdown) {
  if (breakdown.title < 12) {
    return 'أضف عنوان "' + (profile.targetTitles[0] || profile.dreamRole) + '" في ملخص سيرتك حتى تطابق هذا الإعلان.';
  }
  if (breakdown.skills < 6 && profile.targetTitles[0]) {
    return 'أبرز الكلمات الأساسية لدور ' + profile.targetTitles[0] + ' في سيرتك.';
  }
  if (breakdown.seniority < 18) {
    return 'أعد صياغة إنجازاتك بحيث تطابق مستوى الدور (' + profile.seniorityLevel + ').';
  }
  return 'سيرتك قريبة — حسّن سطر العنوان وقدّم نسخة مخصصة لهذا الدور.';
}

function rankJobs(jobs, profile, opts) {
  opts = opts || {};
  const limit = opts.limit || 10;
  const scored = (jobs || []).map(j => {
    const breakdown = {
      seniority: _seniorityFit(j.title, profile.seniorityLevel),
      title:     _titleFit(j.title, profile),
      skills:    _skillsFit(j, profile),
      industry:  _industryFit(j, profile),
      location:  _locationFit(j, profile),
      readiness: _readinessFit(j, profile),
    };
    const subtotal = breakdown.seniority + breakdown.title + breakdown.skills
                   + breakdown.industry + breakdown.location + breakdown.readiness;
    const pen = _penalty(j, profile);
    const score = Math.max(0, subtotal - pen.penalty);
    return Object.assign({}, j, {
      match: { score, breakdown, penalty: pen.penalty, flags: pen.flags },
      whyMatched: _whyMatched(j, profile, breakdown),
      cvFixTip:  _cvFixTip(j, profile, breakdown),
    });
  });
  // Filter out jobs that are clearly wrong: title fit 0 AND penalty heavy.
  const filtered = scored.filter(j => !(j.match.score < 25 && j.match.flags.some(f => f.key === 'avoid_title')));
  filtered.sort((a, b) => b.match.score - a.match.score);
  const top = filtered.slice(0, limit);
  const hidden = scored.length - top.length;
  return { top, hidden, all: scored };
}

module.exports = { rankJobs, _titleSeniority, SENIORITY_RANK };
