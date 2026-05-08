-- Darbi Database Schema
-- Run this on your PostgreSQL database

CREATE TABLE IF NOT EXISTS users (
  id               SERIAL PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  referral_code    TEXT UNIQUE,
  access_status    TEXT DEFAULT 'free', -- free | ugc_24h | paid
  access_expires_at TIMESTAMP,
  interview_readiness INTEGER DEFAULT 0,
  cv_readiness     INTEGER DEFAULT 0,
  training_day     INTEGER DEFAULT 0,
  target_role      TEXT,
  paid_at          TIMESTAMP,
  last_activity    TIMESTAMP,
  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS analyses (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id),
  target_role      TEXT,
  cv_text          TEXT,
  readiness_score  INTEGER,
  result_json      JSONB,
  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS training_sessions (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id),
  is_baseline      BOOLEAN DEFAULT false,
  answers_count    INTEGER DEFAULT 0,
  last_score       INTEGER DEFAULT 0,
  avg_score        INTEGER DEFAULT 0,
  readiness_after  INTEGER DEFAULT 0,
  started_at       TIMESTAMP DEFAULT NOW(),
  completed_at     TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ugc_submissions (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id),
  script_type      TEXT,
  video_url        TEXT,
  status           TEXT DEFAULT 'pending', -- pending | approved | rejected
  reviewed_at      TIMESTAMP,
  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_outcomes (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id),
  job_title        TEXT,
  outcome_type     TEXT, -- applied | interview | success | failure
  occurred_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referrals (
  id               SERIAL PRIMARY KEY,
  referrer_id      INTEGER REFERENCES users(id),
  referred_id      INTEGER REFERENCES users(id),
  reward_given     BOOLEAN DEFAULT false,
  created_at       TIMESTAMP DEFAULT NOW(),
  UNIQUE(referrer_id, referred_id)
);

CREATE TABLE IF NOT EXISTS user_roadmaps (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL UNIQUE,
  roadmap_data     JSONB NOT NULL,
  updated_at       TIMESTAMP DEFAULT NOW()
);

-- Phase 4: Training Attempts
CREATE TABLE IF NOT EXISTS training_attempts (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id) ON DELETE CASCADE,
  training_day     INTEGER NOT NULL DEFAULT 1,
  question_text    TEXT,
  mode             TEXT DEFAULT 'written', -- written | voice | video | mock
  transcript       TEXT,
  scores_json      JSONB DEFAULT '{}',
  feedback_json    JSONB DEFAULT '{}',
  attempt_number   INTEGER DEFAULT 1,
  created_at       TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, training_day, attempt_number)
);
CREATE INDEX IF NOT EXISTS idx_training_attempts_user ON training_attempts(user_id, training_day);

-- Audit trail for any change to users.access_status. Sources today:
--   'stripe_webhook'         — Stripe checkout.session.completed
--   'stripe_session_verify'  — POST /api/darbi/payment/success (Stripe-verified)
--   'admin_grant' / 'admin_revoke' — reserved for future admin tooling
CREATE TABLE IF NOT EXISTS access_audit (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER REFERENCES users(id) ON DELETE CASCADE,
  source              TEXT NOT NULL,
  status_to           TEXT NOT NULL,
  stripe_session_id   TEXT,
  actor               TEXT,
  note                TEXT,
  created_at          TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_access_audit_user ON access_audit(user_id, created_at DESC);
