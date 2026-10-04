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
