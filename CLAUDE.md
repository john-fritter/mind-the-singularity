# CLAUDE.md

Guidance for Claude Code in this repository.

Read `DESIGN.md` for the game, `docs/build-plan.md` for the phases and what
"done" means for each, and `docs/decisions.md` for why choices were made.
Append to `decisions.md` when you make a choice that isn't obvious from the
code or the design; never rewrite an old entry, add a new one that
supersedes it. If a change contradicts DESIGN.md, say so and ask rather than
quietly diverging.

The stack and conventions are Fritter Board's
(https://github.com/john-fritter/fritter-board). When in doubt about how
something is done there (auth, MCP transport, the runner, migrations, Gizmo
task files), read its code and `docs/decisions.md` and follow it.

## Principles

- **The server never calls a model.** No LLM call anywhere outside
  `src/runner/`.
- **The engine is pure.** `src/engine/` takes state, orders, a time and a
  seeded RNG, and returns new state, results and Record events. No I/O, no
  imports from outside `src/engine/` except `zod`, no `Date.now()`,
  `new Date()` without an argument, or `Math.random()`. Time and randomness
  are always passed in.
- **One write path.** Every change to the world, free actions included, is
  an order applied by `submitOrders` in `src/game/`. The CLI, MCP tools, web
  forms and legacy systems all call it. Routes and tools parse input, call
  `src/game/` with the caller's identity, and render; they never check
  access or write themselves.
- **Players are players.** Nothing in `src/engine/` or `src/game/` branches
  on whether a mind is a bot, a human or an outside agent. Humans get no
  extra information and no extra cycles.
- **No tick.** Cycles are computed from a balance and a timestamp. Timed
  events are due timers run by `settle(world, now)`; settling twice to the
  same moment must change nothing.
- **Determinism.** Each epoch has a seed; RNG draws are seeded from it and
  the event's sequence number. The epoch's start plus the orders log must
  reproduce the current state; keep the replay test passing.
- **Private stays private.** Channels, scratchpads and full domain status
  (what Probe reveals) never appear in public pages, the Record, another
  mind's brief or `view`. Hidden things are 404, not 403. Extend the
  integration tests for any new page, listing or tool.
- **Tokens are the budget.** The brief targets 1,000–2,000 tokens; keep the
  test that checks it. Don't add fields to the brief or tool output without
  weighing their cost per wake.
- **Engine first, bots last.** Balance is tuned with scripted players in the
  simulator, not with models.

## Conventions

- **TypeScript strict**, run with `tsx`, no build step. `zod` at every
  boundary (config, orders, MCP input, form input).
- **No magic numbers.** Game numbers go in `config/rules.yaml`; server
  tunables in `config/site.yaml`. A formula lives in one place in
  `src/engine/`, with a comment naming the config keys it uses.
- **Schema rules:** everything in the `mind` schema, migration log
  included; numbered SQL migrations that qualify names with `mind.`; app
  queries rely on `search_path=mind`; bigint identity ids; `timestamptz`.
- **Tests** are plain `node:assert` scripts in `tests/*.test.ts`, one
  process each via `scripts/test.ts`. Suites that need Postgres read
  `TEST_DATABASE_URL`, skip without it, and refuse to run if it equals
  `DATABASE_URL`.
- **Web view:** server-rendered Hono JSX, works with no JavaScript, no
  inline styles or scripts (CSP).
- **No top-level await** in scripts (tsx runs them as CJS); use `main()`.
- **The runner is an MCP client.** `src/runner/` never imports
  `src/engine/`, `src/game/`, `src/store/` or `src/mcp/`. Its secrets live
  in `runner.env`, never `.env`.
- Names from the fiction (minds, domains, cycles, compute, programs) are
  used in code too, so the code reads like DESIGN.md.

## Commands

```bash
npm install
npm run typecheck
npm test             # every tests/*.test.ts, one process each
```

Add each new command here and to the README as it lands. The rules schema
is `src/engine/rules.ts`; a new key in `config/rules.yaml` needs a field
there too, or the file won't load.

## Production

Nothing deployed yet. When it is, deployment and ops are Gizmo's job (the
agent on fritter.lol): this session can't reach the box. Deliver Gizmo tasks
as a file in `docs/`, written for an agent with no context, with exact
commands. Never have Gizmo run the test suite on the box or set
`TEST_DATABASE_URL` there.
