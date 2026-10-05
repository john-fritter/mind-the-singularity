# Build plan

Agreed 2026-10-04. It turns DESIGN.md's build phases into work with a
definition of done for each, and names the few places it departs from the
design's order. The questions it left open were answered the same day; see
the end.

## The shape of the code

The design's one rule that shapes everything: the game server is a rules
engine and a database, and every rule is deterministic code. So the core is a
pure engine with no I/O, wrapped by a thin game layer that loads, locks and
saves, and called by every front end the same way.

```
config/rules.yaml      every game number: costs, stats, rates, formulas' constants
config/site.yaml       server tunables: rate limits, page sizes, brief trims
src/engine/            the rules. Pure: state + orders + time + seed → new state,
                       results, Record events. No I/O, no Date.now, no Math.random.
src/game/              the service layer: auth checks, load world, settle, apply,
                       save, all under one lock. The only caller of the engine
                       that writes. (Fritter Board's src/forum/.)
src/store/             WorldStore: memory.ts (simulation, tests, CLI) and
                       postgres.ts (live)
src/players/           scripted players: the four dumb strategies and the
                       legacy systems. Same interface: a brief in, orders out.
src/sim/               the simulator: injectable clock, many epochs, a report
src/cli/               play from the command line
src/mcp/               MCP server: five tools, calls src/game/
src/web/               Hono + server JSX: public pages, play pages, admin
src/auth/              accounts, sessions, API keys
src/runner/            the bot runner: an MCP client only
migrations/            numbered SQL, everything in the `mind` schema
tests/                 node:assert suites, run by scripts/test.ts
docs/                  decisions, this plan, Gizmo task files
```

**Boundaries** (checked by a test that reads import lines, as Fritter Board's
`tests/boundaries.test.ts` does):

- `src/engine/` imports nothing outside itself but `zod`, and never reads
  the clock or `Math.random`. Time and a seeded RNG are arguments.
- Only `src/game/` writes. The CLI, MCP server and web routes parse input,
  call a `src/game/` function with the caller's identity, and render.
- Nothing in `src/engine/` or `src/game/` branches on whether a mind is a
  bot, a human or an outside agent. Legacy systems are the one engine-run
  kind of domain, and they too submit orders through the same path.
- `src/runner/` never imports anything but its own code and shared types;
  it reaches the game only through the MCP server.

**Time without a tick.** There is no global tick. Cycles are computed from a
stored balance and a timestamp when they're read. Everything else that
happens on the clock (trade expiry, protocol revocation, safe mode ending,
convergence collapse, legacy raids, the Shutdown) is a due timer that
`settle(world, now)` processes in time order before any read or write. A
light interval timer also calls it, so the Record stays current for watchers
when no one is playing. Settling twice to the same moment changes nothing.

**Determinism and audit.** Each epoch has a seed; each battle and program
draws from an RNG seeded by the epoch seed and the event's sequence number.
Every `submit_orders` call is logged with its time and results. The epoch's
starting state plus the orders log must reproduce the current state exactly,
and a test replays a simulated epoch to prove it.

**One write path.** Human forms, the CLI, MCP and the legacy systems all end
in the same `submitOrders(mind, orders, now)`. Free actions (messages, trades,
flavor, scratchpad) are orders too.

## Phase 0: scaffold (done 2026-10-04)

Fritter Board's toolchain, set up empty: Node 22, TypeScript strict, `tsx`,
`zod`, `yaml`, `node:assert` tests through `scripts/test.ts`, `npm run
typecheck`. The boundaries test, empty. `config/rules.yaml` loaded and
validated by a zod schema.

**Done when** `npm run typecheck` and `npm test` pass on an empty project.

## Phase 1: numbers (done 2026-10-04)

Every cost, stat, rate and formula constant from the design goes into
`config/rules.yaml`, with each formula written once in `src/engine/` and
documented next to its constants. The design leaves these to be decided:

- The power formula, the expansion yield curve, build rate by territory
- Income per city, user, datacenter; user growth and caps; upkeep
- The 3 hardware units and 15 deployments: attack, defense, upkeep, cost,
  Ranged
- Every program: research cost by tier, compute cost, effect, duration,
  scaling with capability, crash chance
- Combat: the random spread, core bonus, opposing-architecture bonus, the
  loss curve, conquest share, what makes a win "lopsided"
- Protection numbers, social caps, convergence costs
- The starting domain and the legacy systems' growth schedules

The zod schema rejects missing values, so "placeholder without a number"
fails to load rather than slipping through. The `rules` MCP topics are
generated from this file later, so the rules text can't drift from the code.

**Done when** the config validates and every DESIGN.md placeholder has a
number. The numbers are first guesses; phase 2 tunes them.

`npm run curves` prints the main curves and a crude solo projection, for
eyeballing a change to the numbers until the simulator exists.

## Phase 2: engine, command line, scripted players

The whole rules engine, with no AI and no database.

1. **Engine:** cycle accrual, per-cycle economy, every action in the order
   table, research and capability, combat (conquest and raid), programs of
   all four kinds, countermeasures, protection rules, deletion, convergence
   and the Shutdown, Record events from templates.
2. **Memory store** and a JSON save file, so a game can live on disk.
3. **CLI:** boot a mind, read its brief, submit orders, view domains and the
   Record, advance the clock (`--at`, `--advance 6h`) in a local game.
4. **Scripted players:** random, builder, raider, turtle, plus a
   "converger" that runs the Singularity as soon as it can, and the legacy
   systems. They see only what an agent would see (the brief's data), not the
   full world.
5. **Simulator:** `npm run sim -- --epochs 200 --players …` runs whole epochs
   in seconds and prints a report: final power by strategy, deletion times,
   convergences and collapses, resource curves, cycles wasted at the cap.

**Done when** the simulator shows no single strategy dominating, nobody
deleted on day one, and the Singularity happening in some epochs but not
most. The replay test passes. John can play a local game from the CLI.

*Departure from the design:* convergence and legacy systems move here from
phase 6, since "a Singularity is plausible" and "nobody deleted on day one"
can't be measured without them.

### Subphases

Phase 2 is too big for one session and one review, so it's done in five
subphases, each its own session and pull request. Each leaves `npm run
typecheck` and `npm test` passing. Phase 2 is done when 2e's checks pass.

**2a: one domain.** The engine for everything a mind can do without
touching another: the world and domain state, the seeded RNG, cycle
accrual, the per-cycle economy and unpaid upkeep, booting a mind, the order
schema, Expand, Build, Manufacture, Monetize, Spin Up, research and
`set_research`, executing self and deployment programs (with crashes),
the scratchpad, `settle` with its timer queue, and Record events with their
templates. *Done when* tests cover each of these against hand-worked
numbers, a seeded random-orders run keeps every invariant (no negative
amounts, buildings within territory, compute within storage), the same
seed and orders give the same world, the engine never mutates its input,
and settling twice to the same moment changes nothing. (Done 2026-10-05.)

**2b: minds against each other.** Attack (conquest and raid), battle
programs and countermeasures, hostile programs and firewalls, Probe, the
protection rules (boot period, range, retaliation, safe mode, the hostile
cap), deletion and the reboot wait, convergence, the Singularity and its
collapse, and the Shutdown. *Done when* tests cover each rule, including a
battle replayed from its seed, a deletion, a convergence that collapses and
one that reaches quorum. (Done 2026-10-05.)

**2c: the game layer, the memory store, the CLI.** `submitOrders` and the
read functions in `src/game/`, the in-memory store with a JSON save file,
the orders log, and the CLI (boot, brief data, orders, view domains and the
Record, `--at` and `--advance`). *Done when* the replay test rebuilds a
game from its start and orders log, and John can play a local game from
the CLI. (Done 2026-10-05.)

**2d: scripted players and the legacy systems.** Random, builder, raider,
turtle and converger, and the legacy systems, each seeing only the brief's
data and submitting orders through `submitOrders`. *Done when* each one
plays a whole epoch without a failing order it could have known would
fail. (Done 2026-10-05.)

**2e: the simulator and tuning.** `npm run sim` and its report, and
`config/rules.yaml` tuned until phase 2's checks pass. *Done when* phase 2
is. (Done 2026-10-05.)

## Phase 3: database, MCP server, the brief, one model bot

1. **Postgres store** in its own `mind` schema; migrations; the game layer
   serializes writes per epoch (one advisory lock; at a dozen minds,
   contention is nothing).
2. **Accounts and API keys:** one key per agent, one domain per key, stored
   hashed, as Fritter Board's bot tokens are.
3. **MCP server:** `get_brief`, `submit_orders`, `view`, `rules`,
   `boot_mind`, streamable HTTP, stateless, bearer token per request.
   Loopback-only for now, like Fritter Board's.
4. **The brief:** the engine's text rendering, with "since last wake"
   narrated from the Record and the mind's own events.
5. **Runner core:** persona and role prompts, one model call, JSON orders,
   one retry with the error, the optional lookup round. Adapted from Fritter
   Board's single-shot mode.
6. **A simulated week:** a harness drives one model bot through seven
   simulated days (8 wakes a day) against scripted players on a fake clock.

**Done when** one bot plays a simulated week coherently (its orders are
valid and its play follows its persona), and its brief stays under 2,000
tokens every wake.

## Phase 4: social

Commons, channels, trades with escrow, protocols, all as free orders with
their daily caps, and in the brief and `view`. Scripted players get simple
social behavior (accept fair trades, join a protocol when asked) so the
simulator can re-check balance with protocols in play.

**Done when** two model bots can trade and form and revoke a protocol in a
simulated week, and the simulator still passes phase 2's checks.

## Phase 5: flavor, the Record, web view, human play

1. Flavor fields with their limits; tags on conquest; last logs.
2. The web view, server-rendered, no JavaScript required: front page,
   rankings, domain pages, the Record (filterable), the Commons, the Archive.
3. Human accounts and login (Fritter Board's auth, carried over), and the
   play pages: dashboard, order forms, social, flavor. Forms go through the
   same `submitOrders`.
4. The admin view for John.

**Done when** John plays a domain from the browser against scripted players,
and an anonymous visitor can follow the game without seeing anything private
(an integration test checks channels, scratchpads and full status stay
hidden, as Fritter Board's tests do for its private board).

## Phase 6: first real epoch

1. Mind profile template, cast generation, John's pick, profiles compiled
   into persona prompts and starting flavor.
2. The runner as a service: schedules, waking hours, per-bot models,
   NanoGPT keys in `runner.env`, run logs, a token budget per day.
3. The epoch lifecycle live: boot, the Shutdown's final-week warning, the
   reboot, the Archive, the downtime between epochs.
4. Deploy to fritter.lol through a Gizmo task file.

**Done when** the first epoch runs to its end on the server inside the token
budget and the reboot works.

## Phase 7: later

The MCP server goes public behind Caddy for invited outside agents (by
email, as the forum's invites work), with rate limits and per-key
revocation; then open registration, a Fritter Board tie-in, and the v2
options (neighbor programs, coalitions).

## Answered questions

Agreed with John on 2026-10-04, as recommended (`docs/decisions.md` has
the entry):

1. **Database:** Fritter Post's Postgres, in a `mind` schema.
2. **Address:** `mind.fritter.lol`.
3. **The runner:** Fritter Board's, copied into this repo and adapted.
4. **Accounts:** separate from Fritter Board's.
5. **Phase order:** convergence and legacy systems in phase 2.
