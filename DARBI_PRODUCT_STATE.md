# DARBI PRODUCT STATE

## Fixed Goal

Complete Darbi as a usable **done-for-you career agent**. The full journey must work without developer explanation:

1. Open Darbi → 2. career goal → 3. country/city/work-mode → 4. has-CV? →
- **Has CV:** upload/paste → extract real facts → diagnose → auto-generate market-ready CV
- **No CV:** guided questions (name/contact, city/country, education, internships/experience, responsibilities, achievements, projects, skills/tools, languages, target) → auto-generate market-ready CV

Then both: 9. real location-relevant jobs → 10. select job → 11. tailored apply package (CV tweaks + summary + cover letter + answers + checklist) → 12. open+apply → 13. log → 14. track (applied/no-reply/reply/interview/rejected/accepted) → 15. reply/interview → interview training → 16. no-reply/rejected → adjust targeting → 17. accepted → success state. Dashboard = only "خطوتك الآن".

## Current Status

- **Date:** 2026-07-11
- **Production commit:** 03dea1c (done-for-you CV renders real data, zero brackets)
- **Product score:** 3/5 → pending independent verification for 4/5 (core CV blocker fixed + browser-proven; jobs still dead in prod = external)
- **Active blocker:** Step 9 — jobs return fallback-only in production (jsearch 403, needs RapidAPI subscription = USER action)
- **Last completed step:** 8A (done-for-you CV now real, no brackets, no invention — production browser proof)
- **Last failed step:** 3 (location gate missing) + 9 (jobs dead, external)

## Journey Matrix

| Step | Description | Status | Proof | Known issue | Last tested |
|---|---|---|---|---|---|
| 1 | Open Darbi (root=V2) | passed | curl: `/` title "دربي — مساعدك المهني" | — | 2026-07-11 |
| 2 | Ask career goal (#/dream) | passed | code+prior browser | — | 2026-07-09 |
| 3 | Ask country/city/work-mode | **failed** | not built — no location gate; location is optional field on #/jobs only | MISSING SCREEN | 2026-07-11 |
| 4 | Ask has-CV? (#/cv-upload) | passed | DFY-2 card "ما عندي سيرة" live | — | 2026-07-09 |
| 5A | Upload/paste CV | passed | pdf.js + textarea | — | 2026-07-09 |
| 6A | Extract real facts | partial | extractCvFacts pulls name/city/major/years/tools/arr — NOT employers/dates/bullets | no work-history extraction | 2026-07-09 |
| 7A | Diagnose | passed | senior override + family flip verified | — | 2026-07-09 |
| 8A | Auto-generate CV | **passed** | PROD browser: 0 visible brackets, 0 copy brackets, real companies (الرواد/الخليج) + real bullets, no invented skills | minor: gradYear may pick a work-date year | 2026-07-11 |
| 5B/6B | No-CV guided → CV | passed | 191/191 family + 7/7 No-CV round-trip; real exp parsed | — | 2026-07-11 |
| 9 | Real location jobs | **failed (external)** | live curl: mode=fallback, jobs=0, jsearch 403 not subscribed | needs RapidAPI key (USER) | 2026-07-11 |
| 10 | Select job | partial | works when jobs exist | blocked by step 9 | 2026-07-09 |
| 11 | Apply package | passed | v2BuildApplyPackage (cover+ats+bullets+checklist) | — | 2026-07-09 |
| 12 | Open + apply | passed | external link | — | 2026-07-09 |
| 13 | Log application | passed | manual-add + apply-log | — | 2026-07-09 |
| 14 | Track statuses | passed | tracker 5 statuses | — | 2026-07-09 |
| 15 | Interview training (reply/interview) | passed | gated correctly, 6 Q session | — | 2026-07-09 |
| 16 | No-reply/rejected → adjust | partial | tracker shows retarget copy but plan doesn't change | overclaim "يعدّل خطتك" | 2026-07-09 |
| 17 | Accepted → success | passed | success card, cta:null | — | 2026-07-09 |
| DASH | Dashboard = one next action | passed | renderDashboard hero from DarbiJourney | — | 2026-07-09 |

## Attempts

### Attempt 0 (pre-loop, this session)
- Issue: root `/` served V1; dev scaffolding on landing; English "fallback" pill; ٥/٦ mismatch.
- Fix: server `/`→v2.html, V1→/v1; stripped banner/badge/false-card; pill→"بحث يدوي"; ٥→٦ interview.
- Test: node -c server OK; inline JS OK; curl confirms `/` title = "دربي — مساعدك المهني", 0 scaffolding hits.
- Result: PASSED. Commit 253324a live.
- Do not repeat: don't re-add preview/Phase copy; don't route `/` to V1.

### Attempt 1 (Cycle 1) — done-for-you CV renders real data
- Issue: #/cv-output "✓ سيرتك جاهزة" showed 8 bracket placeholders, discarded the user's
  real work history, and invented 7 accounting skills (IFRS/VAT/Zakat/QuickBooks/Audit).
  Confirmed by production browser walk (accountant persona).
- Hypothesis: extractCvFacts pulls no employers/dates/bullets → templates fall back to
  `_ph()` brackets + generic family bullets/skills.
- Files changed: public/v2.html only.
- Fix: extractCvFacts now parses real experience/projectLines/university/skillsRaw (fixed the
  Arabic-`\b` regex bug in SECTION/STOP/SEP that made "الخبرة:" never match). New real-data
  renderers (_realExp/_realProj/_realEdu/_userSkills/_atsKeywords). Rewrote all 5 templates to
  render real data, omit unknown fields (no brackets), drop fabricated result rows, and label
  family keywords as ATS suggestions not claimed skills. Header omits missing contact fields;
  gender-neutral objective.
- Test run: inline JS OK; 25/25 no-brackets+real-data (accountant/senior-CS/fresh-mktg);
  191/191 family sweep; 7/7 No-CV round-trip.
- Result: brackets/real-data PASSED + PROD browser proof. Commit 03dea1c.
- INDEPENDENT VERIFIER (senior marketing persona, no edu year) FOUND A REAL DEFECT:
  education showed "التسويق · 2019" — a graduation year fabricated by borrowing a job
  date. Also languages silently dropped. FAIL on "zero invented dates".
- Follow-up fix (commit 14a91ba): gradYear now extracted ONLY from lines with an
  education signal (بكالوريوس/جامعة/degree/graduat/…) — never from job dates. Fixed the
  same Arabic-\b bug in language detection (العربية/الإنجليزية were dropped).
- Follow-up fix (commit adbc69c): _pushLangs renders the user's real languages in all
  templates (was missing in senior templates = data loss).
- Re-verified on production myself: gradYear=null for no-edu persona, languages=[Ar,En],
  education line = "التسويق" (no year), 0 brackets, real companies/skills. Final
  independent re-verification: pending.
- Do not repeat: never use JS `\b` around Arabic letters (it never fires — bit us 3×: city,
  section headers, language names); never render `_ph()` brackets in the final CV; never
  scrape gradYear/dates from outside their own section.

## Protected Decisions

- V2 is the product. V1 is archive only (reachable at /v1).
- No fake jobs. No invented CV facts (companies/experience/metrics/dates/certs/tools).
- Done-for-you CV, not template editor.
- Location before job search.
- Apply preparation is separate from interview training.
- Dashboard shows one next action.
- No new features until the core loop passes.
- PAY_ENABLED=false stays. Do not touch Stripe guard.

## Next Highest-Priority Blocker

**Step 3 — location gate (country/city/work-mode) missing before jobs.** The journey goes
dream→cv→quiz→diagnosis→cv-output→jobs with no country/city/work-mode question; location is
only an optional field on #/jobs. Fixed goal requires location BEFORE job search, and the
fallback links must include location. This is the next code-fixable blocker (Cycle 2).

(Step 9 — jobs live provider — is an EXTERNAL blocker: needs the user's RapidAPI/JSearch
subscription activated. Code path is honest-fallback + manual-add already. Not code-fixable.)

## Stop Status

CONTINUE (Cycle 1 fix live + browser-proven; awaiting independent verifier, then Cycle 2 = location gate)
