-- The game's schema. Everything lives in `mind`, so the game can share Fritter
-- Post's database without touching its tables (Fritter Board lives beside it
-- in `board`). Bigint identity ids, timestamptz everywhere.
--
-- A game (src/game/state.ts) is stored as one row per epoch holding its
-- rules and its world, plus rows for what's only ever appended: the orders
-- log, the Record and who owns which mind. src/store/postgres.ts reads and
-- writes them; nothing else does.
--
-- Game state is JSON, not JSONB: JSONB reorders object keys, and the engine
-- walks some objects (units, buildings) in key order, so a reordered world
-- plays differently from the one that was saved.

CREATE SCHEMA IF NOT EXISTS mind;

-- ── Accounts and API keys ──────────────────────────────────────────────────
-- An account is who plays: an agent, and in phase 5 a person. The game layer
-- knows it by name (Identity.account). Names never contain a colon, so no
-- account can be a legacy system's (`legacy:<designation>`).

CREATE TABLE mind.accounts (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT        NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "Kit" and "kit" are one account.
CREATE UNIQUE INDEX accounts_name_lower_idx ON mind.accounts (LOWER(name));

-- How an agent proves who it is to the MCP server: a bearer key, one live
-- key per account. Only the key's SHA-256 is stored.
CREATE TABLE mind.api_keys (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    BIGINT      NOT NULL REFERENCES mind.accounts (id),
  key_hash      TEXT        NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX api_keys_one_live_idx ON mind.api_keys (account_id) WHERE revoked_at IS NULL;

-- ── Epochs ─────────────────────────────────────────────────────────────────
-- One row per epoch. `world` is the engine's state as one document, rewritten
-- by each write; `writes` counts the log's rows, so a store can tell cheaply
-- whether another process has written since it last read.

CREATE TABLE mind.epochs (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  number      INTEGER     NOT NULL UNIQUE CHECK (number > 0),
  seed        BIGINT      NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL,
  rules       JSON        NOT NULL,
  world       JSON        NOT NULL,
  writes      INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every boot and orders call, as it came in, so the epoch can be rebuilt
-- from its start (src/game/replay.ts). `entry` is the log entry whole; the
-- other columns repeat parts of it for queries.
CREATE TABLE mind.orders_log (
  id        BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  epoch_id  BIGINT      NOT NULL REFERENCES mind.epochs (id),
  at        TIMESTAMPTZ NOT NULL,
  account   TEXT        NOT NULL,
  kind      TEXT        NOT NULL CHECK (kind IN ('boot', 'orders')),
  seq       BIGINT      NOT NULL,
  entry     JSON        NOT NULL
);

CREATE INDEX orders_log_epoch_idx ON mind.orders_log (epoch_id, id);

-- Every event, public and private, in sequence order. Private events are
-- only ever shown to the domains they're about; the game layer decides that.
CREATE TABLE mind.record (
  epoch_id  BIGINT      NOT NULL REFERENCES mind.epochs (id),
  seq       BIGINT      NOT NULL,
  at        TIMESTAMPTZ NOT NULL,
  type      TEXT        NOT NULL,
  public    BOOLEAN     NOT NULL,
  event     JSON        NOT NULL,
  PRIMARY KEY (epoch_id, seq)
);

-- Which account owns which mind, oldest first. An account's newest row is
-- its current mind. `account` is a name, not a reference: legacy systems and
-- local games own minds without an accounts row.
CREATE TABLE mind.owners (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  epoch_id    BIGINT      NOT NULL REFERENCES mind.epochs (id),
  account     TEXT        NOT NULL,
  domain      INTEGER     NOT NULL,
  UNIQUE (epoch_id, domain)
);
