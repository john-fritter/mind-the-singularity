-- Phase 5c: people log in to the web view, and scripted players run on the
-- server's clock.

-- A person's password, argon2id, for the web view. An account may have a
-- password, an API key, or both; either way it plays the same one mind.
ALTER TABLE mind.accounts ADD COLUMN password_hash TEXT;

-- Logged-in browsers, as Fritter Board's: the cookie holds a random token,
-- and only its SHA-256 is stored here.
CREATE TABLE mind.sessions (
  id            TEXT        PRIMARY KEY,
  account_id    BIGINT      NOT NULL REFERENCES mind.accounts (id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX sessions_account_idx ON mind.sessions (account_id);

-- The scripted players seated in an epoch, which the server wakes on its
-- clock (src/players/clock.ts). `account` is a reserved `bot:` name, never
-- an accounts row; `boot` is the input the mind was booted with.
CREATE TABLE mind.seats (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  epoch_id    BIGINT      NOT NULL REFERENCES mind.epochs (id),
  account     TEXT        NOT NULL,
  strategy    TEXT        NOT NULL,
  seed        BIGINT      NOT NULL,
  boot        JSON        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (epoch_id, account)
);
