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

## 2026-10-04 — Phase 1: the numbers

John agreed the phase 1 proposal and its recommendations. Every number
DESIGN.md left open is now in `config/rules.yaml`, and each formula is a
pure function in `src/engine/` (`economy.ts`, `units.ts`, `programs.ts`,
`combat.ts`, `power.ts`, `convergence.ts`) whose comment names the keys it
reads. Phase 2 builds the engine on these functions rather than writing
its own.

**Decided with John:**

- **The opposing-architecture bonus is the attacker's.** An attacker's
  strength is multiplied by `1 + combat.opposing_attack_bonus` (+10%) when
  the defender is opposite it on the wheel. A symmetric damage bonus would
  have made fights between opposites bloodier, which discourages them;
  DESIGN.md wants opposites to be natural enemies.
- **Each self program says what its duration counts.** Abundance Protocol
  and Overclock count cycles the caster spends; Hardening and False
  Signature count hours. With real time, an economy or attack buff could be
  run once and stacked under a whole 96-cycle batch spent in one moment.
  Defensive ones count hours because they matter while the mind sleeps.
- **Building cost rises with territory:** base ×
  `(1 + territory / build.cost_territory_scale)`, as in Archmage. Without
  it, capital stopped mattering once a domain was big enough.

**Smaller calls, made here:**

- **Ids in code, names and numbers in config.** `src/engine/architectures.ts`
  fixes the ids of architectures, buildings, units and programs, the wheel,
  and which deployments and programs each architecture has. The schema
  requires a config entry for every id and rejects any other. Display names
  are `name` fields in the config, so the placeholder names can change
  without code. Each of the 15 non-deploy architecture programs has its own
  strict schema, since phase 2 writes code for each effect anyway.
- **A deployment's program has the deployment's id**, and deploy programs'
  compute and unit counts are set by tier (`programs.deploy`); the units'
  stats are per deployment.
- **Tiers:** deployments by their column in DESIGN.md; Probe and self
  programs tier 1, battle tier 2, hostile tier 3 (`research.tier_by_kind`).
  The Singularity has its own research cost and never crashes
  (`programs.singularity.can_crash: false`).
- **Everyone starts with no programs**, so capability starts at 0. The first
  program comes around day 4, after the boot period.
- **Capability scaling caps shares at 1.** Effect sizes are multiplied by
  `1 + 0.1 × capability`; a share or chance never passes 1.
- **Probe isn't hostile:** firewalls don't block it and it isn't an act of
  war.
- **The hostile-program cap counts every sender together** against one
  target per day.
- **A tie goes to the defender.**
- **Conquered land arrives open.** The defender's buildings on it are
  destroyed in proportion, cores excepted; only a lopsided win (strength
  ratio ≥ 1.5) destroys a core. With 10 starting cores, the boot period and
  safe mode, the earliest possible deletion is days away.
- **Hardware upkeep is the main capital sink**, as gold upkeep is in
  Archmage: housing is generous (`manufacture.housing_per_factory`) and
  upkeep high enough that a domain's army is bounded by its income.
- **Rounding:** formulas that return counts (sectors, buildings, units)
  return integers; amounts of capital, compute, users and research come
  back exact and the engine rounds down where it writes state; costs round
  up.
- **Legacy systems are ordinary domains with a fixed order mix**: the
  starting domain scaled up or down, spending `cycles_per_day` cycles a day
  in their `orders`, `buildings` and `hardware` mixes, never researching,
  not counted toward the quorum. That keeps them on the one write path.
- **`start.cores` became `start.buildings.core`**, since a core is a
  building.

**Calibration.** The numbers were fitted to the day-12 example brief in
DESIGN.md and checked with `npm run curves`, which prints the curves and
a crude solo projection. The first draft let a balanced player learn all
eight programs by day 17 and pile up millions of unspendable capital. So
research costs went up 2.5×, capital per user went down, and hardware
upkeep and housing went up. The projection now reaches about 900 sectors
and capability 4 by day 12, and the full research path around day 39 for a
player with a fifth of its buildings in labs. That fits "a Singularity in
some epochs, not most", but it is a guess for the simulator to test.

## 2026-10-05 — Phase 2 in subphases

Phase 2 is too much for one session and one review, so John agreed to
split it into five subphases, each its own session and pull request: 2a
one domain, 2b minds against each other, 2c the game layer, store and
CLI, 2d scripted players and legacy systems, 2e the simulator and tuning.
`docs/build-plan.md` gives each a definition of done. He also agreed that
in tuning, numbers in `config/rules.yaml` may change as the simulator
needs, with each change and its reason logged here.

## 2026-10-05 — Phase 2a: one domain

The engine now runs a domain on its own: `createWorld`, `bootMind`,
`applyOrders` and `settle` in `src/engine/world.ts`, each returning a new
world and the events it produced without changing the one it was given.
Choices the design didn't make:

- **Times are milliseconds** since the Unix epoch, as plain numbers, so
  the world is plain JSON a store can save as it is.
- **Cycles accrue on a fixed grid** from the domain's boot, one per
  `cycles.interval_minutes`. The stored balance is synced only when
  cycles are spent; reads compute it. A part-finished interval is never
  lost, and cycles lost to the cap are counted (`cyclesWasted`) for the
  simulator's report.
- **The action comes first, then the cycle's economy.** A building
  finished this cycle earns this cycle, and an order that can't do
  anything fails before spending a cycle. An order that can do part of
  what was asked does that part and says why it stopped.
- **`cycles` in an order is cycles to spend.** Expand, Monetize and Spin Up
  take it; with each costing one cycle, that's the number of times.
- **A Build or Manufacture batch can mix kinds** (`{"buildings": {"city":
  5, "lab": 5}}`) as well as take one (`{"building": "city", "count":
  12}`), since a batch's size is shared. It stops after a batch that hit a
  limit other than its size (capital, land, housing, users), rather than
  spending a cycle per building as income trickles in.
- **Whole numbers in state.** Income and growth round down; upkeep rounds
  up. Unpaid upkeep takes what capital (or compute) there is and loses
  `economy.shortfall_loss_share` of each hardware (or deployment) type;
  buildings are never abandoned.
- **Research overflow is lost** and the target clears when a program is
  learned, so the brief can show the mind has nothing being researched.
- **A self program run again restarts** its duration rather than
  stacking. Abundance Protocol's capital bonus counts toward Monetize,
  which is "one cycle's income".
- **A crash is a failed order** that still spent its compute and cycle.
- **Names or ids.** Orders may name buildings, units and programs by id or
  display name, in any case.
- **The Record isn't in the world.** Each call returns its events; the
  store appends them. Events carry the names they need as they were, so
  entries read right after a mind is deleted. Public events are the
  Record; private ones go only to the domains they're about.
- **One sequence counter** numbers both orders and events. Each order
  draws from an RNG seeded by the epoch seed and its sequence number; a
  malformed order takes no number. The RNG is sfc32 seeded through
  FNV-1a, in `src/engine/rng.ts`.
- **Submitting orders marks a mind active** (for the quorum's "woke in
  the last 72 hours"). Phase 3 can decide whether reading the brief
  counts too.
- **Battle, hostile, Probe and Singularity runs are refused** until 2b
  writes them.

## 2026-10-05 — Phase 2b: minds against each other

John agreed the 2b proposal and its calls. Attacks, battle programs and
countermeasures, hostile programs and Probe are in `src/engine/conflict.ts`;
the protection rules in `protection.ts`; deletion in `deletion.ts`; the
Singularity, its collapse and the Shutdown in `convergence.ts`. No numbers
in `config/rules.yaml` changed.

**Agreed with John:**

- **The whole force attacks and defends.** DESIGN.md has no partial send,
  and Archmage sends everything.
- **Hostile programs pass the same shields as attacks**: boot period,
  range (with retaliation) and safe mode. Probe passes none of them; it
  isn't hostile.
- **The hostile cap counts every program that reached the target** in a
  rolling 24 hours, blocked ones included, so spam can't grind a domain.
  A crashed program never reaches it and doesn't count.
- **Attacking or running a hostile program ends your own safe mode**, so it
  can't be a free base to strike from.
- **A countermeasure fires** when the attacker's raw attack (units' base
  stats) exceeds `above` × the defender's raw defense, `above` between 0
  and 2. It costs its compute and no cycle, can crash, and doesn't fire
  without the compute.
- **The last log moves to Phase 5** with the other flavor fields; the
  domain has a `lastLog` field waiting for it.
- **The quorum is measured at each join**, from minds active in the last
  72 hours; converged minds count as active.

**Smaller calls, made here:**

- **Orders:** `{"do": "attack", "target", "mode": "conquest"|"raid",
  "program"?}`, `{"do": "execute", "program", "target"}` for hostile
  programs and Probe, `{"do": "set_countermeasure", "program", "above"}`
  (`"program": null` clears it). Targets are designations, any case.
- **A battle program run with an attack** costs its compute but no cycle
  beyond the attack's 2. If it crashes the attack goes on without it.
- **Draws come in a fixed order** so a battle replays from its seed: the
  attacker's program crash, the countermeasure's crash, the random factor,
  then each Adversarial Input miss, the attacker's first.
- **Program effects in a fight** are multipliers fed to Phase 1's
  formulas: Overclock and Arc Strike on the attacker's strength, Hardening
  on the defender's, Arc Strike as a countermeasure on the defender's,
  Entanglement and Adversarial Input on the enemy's; Restoration and False
  Signature on the caster's losses; Recycle Casualties after them.
- **Conquest:** a lopsided win's core goes first. The sectors taken are
  capped so the defender's cores still fit. The defender's other buildings
  go in proportion to the land taken, and more if that's what it takes to
  fit what's left. **Raid:** stolen users arrive up to the raider's user
  cap; the rest are lost.
- **Losing buildings takes what they held.** Compute past the new storage
  is lost and hardware past the new housing is abandoned, in proportion.
  The random-orders test caught compute above storage after a conquest;
  DESIGN.md already says compute past storage is lost.
- **Blight's stall and Exfiltration's cycles don't scale with capability.**
  They're a duration and a count; the shares do scale, capped at 1.
- **Exfiltrated cycles** arrive up to the thief's cap. Stolen compute
  arrives up to its storage.
- **Retaliation** counts attacks (won or repelled) and hostile programs
  (landed or blocked) in the last 24 hours. A repelled attack is aggression
  but not a hit toward safe mode.
- **A converged mind never enters safe mode**, and converging ends one it
  was in.
- **The Record:** a public one-line `battle` event and a private
  `battle_report` to both sides with strengths, programs and losses.
  Hostile programs are public, blocked or not, as acts of war. Probes are
  private to the prober; the target isn't told.
- **A deleted domain stays in the world**, marked with `deletedAt`, so the
  Record and the Archive can name it. It can't act or be targeted, its
  timers go, and its designation is free again after the reboot wait.
  Which account may reboot is 2c's job. If a conquest deletes a converged
  mind, the convergence collapses as "deleted", not "beaten".
- **The Singularity costs `programs.singularity.cycles`** (48) instead of
  execute's 1. It's refused during the join gap and for a mind already
  converged; a collapsed mind may run it again.
- **The Shutdown and its warning are timers** set when the world is created,
  so `createWorld` now takes the rules. An ended epoch clears its timers and
  refuses every order and boot.

## 2026-10-05 — Phase 2c: the game layer, the store, the CLI

John agreed the 2c proposal and its calls. `src/game/` has the one write
path (`bootMind`, `submitOrders`) and the reads (`getBrief`, `view`);
`src/store/` the `WorldStore` interface, the memory store and the save
file; `src/cli/` the CLI (`npm run play`). No numbers in
`config/rules.yaml` changed.

**Agreed with John:**

- **The game layer takes an account, not a domain.** Every call takes
  `{ account }` and finds that account's mind, so a front end can't name
  someone else's. Ownership (`owners`) lives in the game, beside the
  world; the engine stays account-blind.
- **One live mind per account.** After deletion the same account may boot
  again once `deletion.reboot_after_hours` has passed; another account may
  take the freed designation on the engine's terms.
- **Boot is the one write that isn't an order.** It's its own MCP tool in
  DESIGN.md, so it stays `bootMind`, but goes through the same lock, log and
  save as `submitOrders`.
- **An epoch keeps the rules it was created with.** They're copied into the
  game at creation, like the seed, so replay is exact and a local game
  doesn't change under its players while `config/rules.yaml` is tuned. The
  CLI notes when the file has moved on.
- **The log holds every boot and orders call**, with its time, account,
  raw input, results and the sequence number it ended on. Settles aren't
  logged: replay is `createWorld`, each entry, then a settle to the moment
  the world was saved at. Refused calls (no mind, time before the clock)
  change nothing and aren't logged.
- **Reads settle a copy and save nothing.** The next write settles to the
  same result under the same sequence numbers, which a test checks.
- **Brief data, not text.** `getBrief` returns structured data; Phase 3
  writes the text, 2d's players read the data. "Since last wake" is since
  the mind's last orders, newest `brief.events` kept.
- **The CLI's game has its own clock**, stored in the save, moved only by
  `advance`, `--at` or `--advance`. One epoch per save.

**Smaller calls, made here:**

- **`config/site.yaml`** now exists, with the brief's event count and the
  Record view's page sizes, validated by `SiteSchema` in `src/config.ts`.
- **`WorldStore.update(fn)`**: `fn` gets the game under the store's lock and
  returns the write (new world, log entry, events, new owner) for the store
  to apply. Appending rather than copying keeps a long simulated epoch from
  going quadratic, and it's the shape Postgres needs (update the world, insert
  rows). The memory store queues writes on a promise chain; a write that
  throws doesn't jam the ones behind it.
- **The time can't go backward.** A write before the world's clock is
  refused; a read before it reads the world as it is.
- **Errors carry a code**: `not_found` (what doesn't exist and what you may
  not see, alike), `invalid`, `refused`. Phase 3 maps them to HTTP and MCP.
- **Public means:** designation, domain name, architecture, manifesto,
  power, territory, rank, boot time and a status (active, boot period, safe
  mode, converged, deleted). Rankings list live minds by power, ties by
  boot order. The Record view is public events only, newest first, paged
  by `before`. A designation names the live mind first, then deleted ones,
  newest first.
- **"In range" in the brief** is who you could attack now, leaving out your
  own boot period, so a new mind can see who it will face. The engine's
  `targetShieldedBecause` gives it; `shieldedBecause` still adds the
  actor's boot period for orders.
- **A battle you fought shows once in your brief**, as your private report;
  its public one-liner is left out there.
- **The save file** is checked by a zod schema: the rules in full, the
  world, log and Record by shape only, since they're the engine's own output
  and replay checks the rest. Written to a temporary file and renamed.
- **The boundaries test** now also checks that only `src/game/` imports the
  engine's entry points (`engine/world.ts`).
- **"a Oracle" became "an Oracle"** in the boot line of the Record.

## 2026-10-05 — Phase 2d: scripted players and the legacy systems

John agreed the 2d proposal and its calls. The players are in
`src/players/`: a `Plan` that builds a wake's orders against the brief, the
planned strategies and the random player, the legacy player, and a driver
that runs wakes on the clock. Their knobs are in a new
`config/players.yaml`. No numbers in `config/rules.yaml` changed.

**Agreed with John:**

- **Legacy systems boot with the epoch** as the starting domain times their
  `scale`, marked `legacy`, each owned by a reserved `legacy:<DESIGNATION>`
  account, and order through `submitOrders` like anyone.
- **They're players, not settle timers.** The build plan's "time without a
  tick" lists legacy raids among the timers; its 2d section and the Phase 1
  entry put them on the one write path, which won. Something has to wake
  them: the CLI and the simulator now, the server's interval timer in
  Phase 3.
- **The engine knows a domain is legacy in one place:** legacy domains
  don't count toward the quorum. Never researching is the player's
  behavior. A deleted legacy system stays deleted; its seat never reboots.
- **The order mix is exact over a day:** wake k spends
  `floor(k × per-wake × share)` less what the wakes before it spent, per
  kind. A legacy system keeps its last wake and its next raid time in its
  scratchpad, as an agent would.
- **Players see their brief, the rules and the engine's pure formulas**,
  never the world. The boundaries test lists what `src/players/` may
  import.
- **Builder, raider, turtle and converger are one planner** with four
  settings; random rolls its own. They wake every 3 hours at a seeded
  offset. A wake may take two steps, as an agent may make two calls: the
  raider probes, then decides whether to attack from the report.
- **"Could have known would fail"** is tested by a whole epoch with every
  kind of player: the only failures allowed are crashes, firewall blocks
  and a target's hostile cap, which the brief can't show.
- **The CLI** runs due wakes whenever the clock moves, and `add STRATEGY`
  boots a scripted opponent (account `bot:<designation>`), kept in the
  save's new `players` list.

**Smaller calls, made here:**

- **The game layer boots the legacy systems, not `createWorld`**: the
  engine's `bootLegacy` runs in `startWorld` (`src/game/game.ts`), which
  `newGame` and replay share. Engine tests keep worlds with only the minds
  they boot.
- **A legacy system's brief** hears from the epoch's start until its first
  orders, since it has no boot entry in the log.
- **The plan's estimate is a lower bound.** Cycles, land and purchases are
  exact; capital, compute and users get each cycle's income and upkeep as
  the engine pays them, but no program bonuses and no user growth (Blight
  may stall it). An order goes in only if the estimate says it works.
  Orders that cost nothing go first, so research finishing mid-wake can't
  make `set_research` fail; attacks and hostile programs go only before
  any cycle is spent, since a cycle can change power and so range.
- **Scripted players reboot** after deletion once the wait is over, with
  the same boot input.
- **Speed:** an epoch with four legacy systems and seven players takes
  about five seconds, mostly settling copies for briefs. 2e may want that
  faster for 200 epochs.

## 2026-10-05 — Phase 2e: the simulator

John agreed the 2e proposal and its calls. `npm run sim` is in
`scripts/sim.ts` and `src/sim/`: `epoch.ts` runs one epoch, `run.ts` spreads
epochs over child processes, `report.ts` adds them up and runs the checks.

**Agreed with John:**

- **Phase 2's checks, as numbers:** no strategy finishes top in more than
  50% of epochs; no mind is deleted in its first 24 hours; the Singularity
  happens in 10% to 50% of epochs. The report prints each as PASS or FAIL,
  plus a fourth: no failed order the brief could have foreseen.
- **Each epoch draws its minds**: `--minds` from `--players`, each strategy
  once while there's room, random architectures, plus the legacy systems.
  Epoch i is seeded `--seed` + i, so `--jobs` changes nothing.
- **A Singularity stance per strategy** (`singularity` in
  `config/players.yaml`, from DESIGN.md's mind profile): lead runs it as soon
  as it can; join only while a convergence is underway; hunt attacks
  converged minds by conquest first; never. A boolean before.
- **Player bugs are fixed; player knobs aren't tuned to pass.** Balance is
  tuned in `config/rules.yaml`, each round agreed with John on before/after
  reports.

**Smaller calls, made here:**

- **Speed.** `settle` returns a shallow copy with only the clock moved when no
  timer is due, instead of a deep copy; the engine never changes a world it
  was given, so sharing is safe. The brief scans only the Record's tail for
  what's new. An epoch went from about 6.6s to 3.5s, and 200 epochs take
  about 2 minutes on 4 cores.
- **The simulator reads the whole world** to measure it, as the admin view
  will; it isn't a player. It drives the players a day at a time so wake
  logs don't pile up, and samples every mind on days 10, 20 ... 60.
- **Rank is among the scripted minds**, by final power; a deleted mind
  counts 0. A strategy "wins" an epoch when one of its minds is top.
- **Three planner bugs found by the simulator:** a Probe that couldn't be
  sent (no compute) ended the wake with no orders, so a raider whose
  deployments ate its compute stopped acting for good; a won conquest raised
  building prices (they scale with territory) past the plan's estimate, so
  the plan now prices buildings at an upper bound on its territory; and a
  Probe could be aimed at no one, failing and throwing off the plan's
  income. Players may now import `engine/combat.js` for `conquestSectors`.
- **`--rules`** runs another rules file, for trying a change before making it.

## 2026-10-05 — Tuning round 1

Agreed with John on 200-epoch runs (`/mnt/project-files/phase-2e/findings.md`
in the project has the tables).

- **Raiders join a convergence instead of hunting it.** A converged mind
  loses range and safe mode, so with every raider hunting, each convergence
  was conquered at the next raider wake (about 3 hours), the converger re-ran
  the Singularity daily and was farmed for land, and raiders topped 64% of
  epochs. No rules change tried (defender core bonus, cheaper research, an
  army for the converger) let a convergence survive. With raiders joining,
  random minds still beat converged ones now and then. Singularity: 0% → 28%.
- **`power.per_force_point` 0.25 → 0.13.** At 0.25 a sentry wall or an army
  outweighed territory and buildings, so army-heavy strategies topped the
  rankings. Turtles top 56% of epochs after it, so the check still fails.

## 2026-10-05 — Tuning round 2

Agreed with John on 200- and 600-epoch runs (`/mnt/project-files/phase-2e/findings.md`
in the project has the tables). On round 1's numbers a player that conquers
instead of raiding topped every epoch, so conquest was tuned.

- **Attacks get dearer the more a mind attacks** (a DESIGN.md change). An
  attack costs `action_cycles.attack` plus
  `combat.attack_cycles_per_recent_attack` (2) for each attack the mind made
  in the last 24 hours. The domain keeps `attacksMade`; the brief shows the
  next attack's cost (`attackCycles`), so players plan with it. A flat
  higher cost was a cliff, not a lever: bots wake with about 6 cycles, so 5
  cycles left conquerors top 100% of epochs and 6 left them 50% only because
  they could no longer probe and attack in one wake.
- **`expansion.yield_min` 1 → 6.** At 1, Expand was worth 1–2 sectors a
  cycle once a domain passed 1,250 sectors, against about 10% of a victim's
  land for one conquest, so conquest was the only way to grow. John approved
  5 first; 5 passed the 50% check by one point over 600 epochs (conqueror
  49%), so he picked 6 for margin (conqueror 44%).
- **A conqueror strategy**, in `config/players.yaml` and the default sim
  field: the raider's build, attacking by conquest, Singularity stance
  `never`. Without it no one challenges a convergence and the Singularity
  happens in 75% of epochs.
- **Leftover seats are dealt in turn** from epoch to epoch (by the seed)
  instead of drawn at random, so every strategy holds about as many seats
  over a run; a random draw gave one strategy more seats and more wins.
- **A fourth planner bug:** a hostile program a target's cap refuses spends
  nothing, so the plan's estimate now keeps the lower of before and after
  for programs that may be refused.

**Tried and dropped** (round 3 in findings.md): conquest share scaled by
power ratio, a smaller conquest share (mostly turns conquest into core
destruction: more deletions, same winner), flat defense per core, a wider
protection range, longer safe mode, and players that build sentries after
losing a fight. None moved the conqueror below 70%.

## 2026-10-05 — Phase 3's subphases, and 3a: the database

John agreed splitting phase 3 into five subphases in the build plan's
order (3a database, 3b MCP server, 3c the brief as text, 3d runner core,
3e the simulated week), one session and pull request each, and 3a's
proposal: the Postgres store, migrations, accounts and API keys. No numbers
in `config/rules.yaml` changed.

**Agreed with John:**

- **The world is one row per epoch**, rewritten on each write. At a dozen
  minds it's small, and the engine's state stays the one source of truth.
  The orders log, the Record and the owners are rows, only ever appended.
- **An epoch's rules and seed are stored with it**, as the save file holds
  them, so replay from the database is exact.
- **Keys are hashed with SHA-256**, as Fritter Board's bot tokens are: they're
  32 random bytes, so a slow hash adds nothing but time on every call. One
  live key per account; a new key revokes the old. They carry a `mind_`
  prefix.

**Smaller calls, made here:**

- **JSON, not JSONB.** JSONB reorders object keys, and the engine walks some
  objects (units, buildings) in key order, so a world read back from JSONB
  played differently: the equivalence test caught it on its first run. The
  game's state is stored as `json`, which keeps the text as written.
- **The epoch's row lock, not an advisory lock.** The build plan says one
  advisory lock per epoch; `SELECT … FOR UPDATE` on the epoch's row
  serializes the same writes without a lock key to keep apart from Fritter
  Board's in the shared database.
- **The store caches the game and catches up.** Each `PostgresStore` keeps
  the game it last read; `epochs.writes` counts the log's rows, so a read
  is one small query when nothing changed, and otherwise fetches only the
  rows past what it has. A write catches up inside its locked transaction,
  so it always runs against the latest game, whichever process wrote last.
  The cache takes a write only after it commits. Calls on one store run
  one at a time, as the memory store's do.
- **The pool is in `src/db/`**, beside the migrator, as in Fritter Board, so
  `src/auth/` (and 3b's MCP server, through it) reach the database without
  importing the store.
- **Account names** are letters, digits, `_`, `.` and `-`, up to 80, unique
  in any case, and never contain a colon, so no account can be a legacy
  system's. `owners.account` is a plain name, not a reference: legacy
  systems and local games own minds without an accounts row.
- **`npm run epoch -- new`** starts the next epoch now with the rules as
  they are, and refuses while the last one is still running. The epoch's
  lifecycle (boot, reboot, Archive) is phase 6's.
- **The equivalence test** plays eight days of every scripted strategy and
  the legacy systems in memory and in Postgres, the Postgres one through two
  stores on two pools taking turns call by call, and checks the games match
  and the stored log replays to the stored world.

## 2026-10-05 — Phase 3b: the MCP server

John agreed the 3b proposal: DESIGN.md's five tools over streamable HTTP,
stateless, loopback-only, a bearer key per request, as Fritter Board's MCP
server is built (`src/mcp/`, `npm run mcp`). No numbers in
`config/rules.yaml` changed.

**Agreed with John:**

- **`get_brief` returns the brief's data as JSON** until 3c writes the text.
  The tool's name and input stay the same.
- **`rules` is generated, not written.** Each topic is fixed prose that
  names config keys and holds no numbers, followed by the epoch's own
  numbers for it as YAML, cut from the rules stored with the epoch
  (`src/game/topics.ts`). A test checks the prose holds no numbers (bar a
  formula's "1 +"), every key it names exists, every example order parses,
  and every architecture program is described. So tuning `rules.yaml`
  can't leave the text wrong, and an epoch's rules text never changes.
- **The game's refusals are tool errors**, the text starting with the code:
  `not_found: No mind called PIKE.` Bad arguments are the SDK's own input
  errors; a missing, wrong or revoked key is HTTP 401 before any MCP;
  anything unexpected is logged and the caller told only to try again.
- **The clock is injected.** The app takes `now()`, real time in `npm run
  mcp`, so 3e can drive the real server on a fake clock.
- **No rate limit yet,** and **no stdio transport.** Cycles ration play and
  the server is loopback-only; limits come with phase 7's outside agents.

**Smaller calls, made here:**

- **The current epoch comes through `src/game/epochs.ts`**: the newest epoch
  in the database, its store kept for the process so the store's cache
  lasts across requests, replaced when a newer epoch appears. `fixedEpoch`
  wraps one store for tests and the simulated week. No epoch is
  `not_found: No epoch is running.`
- **GET is refused (405).** A stateless server has no messages to push, and
  an open event stream per client would only hold a connection (it kept the
  test process alive). The SDK's client takes the 405 in its stride.
- **Tool output is compact JSON without the `ok` flag**; `rules` is text.
  `boot_mind` takes `domain_name` (MCP arguments are snake_case) and passes
  it to the game as `domainName`.
- **Port 3111 by default** (`MCP_HOST`, `MCP_PORT`), beside Fritter Board's
  3101, so both can run on the box.
- **The boundaries test** now limits `src/mcp/` to `src/game/`, the key
  lookup (`auth/keys.ts`, `db/index.ts`), `dotenv.ts` and the
  architectures' ids from the engine.
- **New dependencies,** Fritter Board's: `@modelcontextprotocol/sdk`, `hono`,
  `@hono/node-server`. Phase 5's web view will use Hono too.
