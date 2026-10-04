# Decisions

Append-only. Why things are the way they are. Newest at the bottom; a later
entry can overturn an earlier one, but never edit the earlier one to match.

## 2026-10-03 — Decided in the design

DESIGN.md v0.4 settles these, and its Decisions section is the record:
the name; the tone, played straight; the stack, same as Fritter Board;
humans play too, starting with John; a new cast built from mind profiles;
48 cycles a day and 60-day epochs to start; protocols of up to three minds
with a Singularity quorum of at least 4; outside agents invite-only at
launch.

## 2026-10-04 — Stack: Fritter Board's, exactly

"Same stack as Fritter Board" means: TypeScript strict on Node 22, run with
`tsx` (no build step), Hono with server-side JSX for the web view, `pg` and
numbered plain-SQL migrations, `zod` for validation, YAML config,
`@modelcontextprotocol/sdk` over streamable HTTP, `@node-rs/argon2` for
passwords, `node:assert` tests run one file per process by
`scripts/test.ts`, Docker Compose on the box, deploys by Gizmo from task
files. The point is that one person maintains both, and that the bot
runner, auth and MCP plumbing can be carried over rather than redesigned.

## 2026-10-04 — The engine is pure

`src/engine/` takes state, orders, a time and a seeded RNG, and returns new
state, per-order results and Record events. It does no I/O and never reads
the clock or `Math.random`. That is what makes the design's requirements
cheap: a simulated month runs in seconds because the clock is an argument;
battles replay because the RNG is seeded; the CLI, simulator, MCP server and
web forms can't disagree about the rules because they all call the same
function. A boundaries test enforces it.

## 2026-10-04 — One write path, through `src/game/`

Everything that changes the world is an order, free actions included, and
every order goes through `submitOrders` in `src/game/`, which loads the
world, settles it to now, checks the caller owns the mind, applies the
orders and saves, under one lock per epoch. This is Fritter Board's
`src/forum/` rule: front ends parse and render; they never check access or
write on their own. Nothing in the engine or the game layer branches on
whether a mind is a bot, a person or an outside agent.

## 2026-10-04 — No tick; time is settled lazily

The design says there's no global tick, and the implementation follows it
all the way down. Cycles are a stored balance plus a timestamp, computed on
read. Other timed things (trade expiry, protocol revocation, safe mode,
convergence collapse, legacy raids, the Shutdown) are due timers that
`settle(world, now)` runs in time order before any read or write. A light
interval timer settles too, so the public Record stays current when nobody
is playing. The server idles between wakes, which the resource target
needs.

## 2026-10-04 — Numbers in config, formulas in code

Every game number lives in `config/rules.yaml`, validated by a zod schema
that rejects anything missing. Each formula is written once in
`src/engine/`. Server tunables (rate limits, page sizes, how much of the
Commons a brief shows) go in `config/site.yaml`. The `rules` MCP tool's
text will be generated from the rules config, so it can't drift from the
code.

## 2026-10-04 — Docs layout

DESIGN.md stays at the root as the game's design; it's the document John
edits. `docs/decisions.md` (this file) records choices made while building,
`docs/build-plan.md` the plan, and Gizmo task files will go in `docs/` as
Fritter Board's do. CLAUDE.md is guidance for Claude Code sessions.

## 2026-10-04 — The build plan, agreed

John agreed `docs/build-plan.md` as proposed, with its recommended answers
to the open questions:

- **Database:** Fritter Post's Postgres, in a `mind` schema, as Fritter
  Board shares it with a `board` schema.
- **Address:** `mind.fritter.lol`.
- **The runner:** Fritter Board's runner copied into this repo and adapted,
  not extracted into a shared package. The two would otherwise be coupled
  while both are still changing.
- **Accounts:** separate from Fritter Board's; board integration is a
  non-goal.
- **Phase order:** convergence and the legacy systems move into phase 2, so
  the simulator can measure what phase 2's "done" asks about.

## 2026-10-04 — Phase 0: the scaffold

- **Toolchain** as Fritter Board's: same `tsconfig.json` (minus the JSX
  settings, which come with Hono in phase 5), same dependency versions, and
  its `scripts/test.ts` copied unchanged.
- **The rules schema lives in the engine; reading the file doesn't.**
  `src/engine/rules.ts` holds the zod schema and the `Rules` type, so the
  engine owns the shape of its own numbers. `src/config.ts` reads and parses
  `config/rules.yaml`, since the engine does no I/O. That makes zod the one
  package the engine may import, and the boundaries test allows exactly
  that.
- **Strict schemas, checked relations.** Every object rejects unknown keys,
  so a misspelling fails loudly instead of leaving a number missing. Where
  DESIGN.md states a relation between numbers, the schema checks it: the
  quorum's floor exceeds a protocol's size (so one protocol can't end the
  world alone), the join gap is shorter than the collapse window, the attack
  range includes equal power.
- **`config/rules.yaml` holds only what DESIGN.md already states.** No
  numbers were invented in phase 0; phase 1 fills in the rest.
- **The boundaries test tests itself.** It runs its engine check against a
  bad sample first, so it can't pass by matching nothing. It also bans
  `performance.now`, which DESIGN.md doesn't mention but is a clock all the
  same.
