-- Phase 6b: the bot runner as a service. The runner (src/runner/) keeps its
-- bots' tunable settings and its wakes here; the admin sees and changes the
-- settings at /admin/bots. The game itself (src/engine/, src/game/'s
-- orders) never reads these tables: a bot plays through /mcp with its key,
-- as any agent does.

-- Each bot's tunables (src/runner/tunables.ts). A bot listed in
-- config/runner.yaml and not yet here is added with the file's settings;
-- after that this row wins. Its persona, boot settings and key names stay
-- in the file and runner.env.
CREATE TABLE mind.runner_bots (
  id               BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name             TEXT        NOT NULL UNIQUE,
  model            TEXT        NOT NULL,
  fallback_models  TEXT[]      NOT NULL DEFAULT '{}',
  reasoning_effort TEXT        NOT NULL,
  json_mode        BOOLEAN     NOT NULL,
  wakes_per_day    INTEGER     NOT NULL CHECK (wakes_per_day > 0),
  "window"         TEXT        NOT NULL,
  daily_tokens     BIGINT      CHECK (daily_tokens > 0),
  paused           BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every wake the service ran or skipped, and every wake by hand. A
-- scheduled one has its local day and slot, so a restarted runner knows
-- which slots ran; tokens are summed per day for the budget.
CREATE TABLE mind.runner_runs (
  id                 BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot                TEXT        NOT NULL,
  day                DATE,
  slot               INTEGER,
  at                 TIMESTAMPTZ NOT NULL,
  outcome            TEXT        NOT NULL CHECK (outcome IN ('done', 'skipped', 'failed')),
  error              TEXT,
  model              TEXT,
  booted             BOOLEAN     NOT NULL DEFAULT FALSE,
  model_calls        INTEGER     NOT NULL DEFAULT 0,
  prompt_tokens      BIGINT      NOT NULL DEFAULT 0,
  completion_tokens  BIGINT      NOT NULL DEFAULT 0,
  reasoning_tokens   BIGINT      NOT NULL DEFAULT 0,
  cached_tokens      BIGINT      NOT NULL DEFAULT 0,
  -- The rest of the wake (lookups, orders, results, note, transcript), as
  -- the runner's WakeResult has it.
  detail             JSON,
  UNIQUE (bot, day, slot)
);

CREATE INDEX runner_runs_day_idx ON mind.runner_runs (day);
CREATE INDEX runner_runs_bot_idx ON mind.runner_runs (bot, id DESC);

-- Every change to a bot's tunables: who, when, and each field's old and
-- new value, so it can be seen and undone (an undo is a change too).
CREATE TABLE mind.runner_config_log (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot         TEXT        NOT NULL,
  changed_by  TEXT        NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changes     JSON        NOT NULL,
  undoes      BIGINT      REFERENCES mind.runner_config_log (id)
);

CREATE INDEX runner_config_log_bot_idx ON mind.runner_config_log (bot, id DESC);
