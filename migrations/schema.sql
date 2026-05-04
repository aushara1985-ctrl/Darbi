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
