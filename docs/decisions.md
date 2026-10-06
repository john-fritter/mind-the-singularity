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

## 2026-10-05 — Phase 3c: the brief as text

John agreed the 3c proposal: one text rendering of the brief, written by
code from the brief's data (`src/game/brief.ts`), returned by the MCP
`get_brief` and printed by the CLI's `brief`. Scripted players still read
the data. No numbers in `config/rules.yaml` changed.

**Agreed with John:**

- **2,000 tokens is a ceiling; 1,000 is a target, not a floor.** The test
  checks only the ceiling. A quiet wake is about 330 tokens, and padding it
  would only spend tokens. This reads CLAUDE.md's and the build plan's
  "1,000–2,000" that way; CLAUDE.md now says so.
- **"Since last wake" is narrated in three parts**: your own events in
  full (battles from your private report), the world's big moments, and
  other minds' fights folded into one line per attacker with no amounts
  (`RAIDER-7 raided MERIDIAN ×2, LOOPBACK; failed against PIKE`). Before,
  the newest 20 visible events were kept, so a busy day's raids elsewhere
  could push out the battle that took your sectors.
- **Tokens are counted with `gpt-tokenizer`** (o200k), a dev dependency
  used only by `tests/brief.test.ts`. No tokenizer matches every model the
  runner may use, so the worst case keeps a margin.

**Smaller calls, made here:**

- **The text is written in `src/game/`, not `src/engine/`.** The build plan
  says "the engine's text rendering", but the brief's data is assembled in
  `src/game/read.ts` and the engine can't import from there. The event
  templates stay in `src/engine/record.ts`. It is still engine-written in
  DESIGN.md's sense: code and templates, no model.
- **A length budget backs the caps.** `config/site.yaml` caps each part
  (your events 6, the world's lines 5, fight lines 5, names per folded line
  4, minds in range 10), and `max_chars` (5,600) caps the whole. Forty-
  character names in every slot can pass the budget with every cap
  respected; then lines go, least useful first: other minds' fights, the
  world's moments, your oldest events, the weakest in range. Your newest
  event and the strongest mind in range always stay. A character budget,
  not tokens, so the server needs no tokenizer; the test shows the budget
  holds: the built worst case with the longest names is about 1,830
  tokens, one with every cap full and short names about 1,850.
- **Measured on a 60-day epoch** of a dozen scripted minds: median about
  330 tokens, max about 600. Phase 4's channels, Commons and offers have
  room, and will share the same budget.
- **The brief's data changed shape:** `since` is now `{ from, yours,
  world, fights, left }`. `from` is when the window opened (the last
  orders, else the boot), so the text can say `SINCE LAST WAKE (7h)`.
  Other minds' events are read up to `brief.scanned` (200), newest kept.
- **Times are relative** ("in 9h") with the current UTC time once in the
  header. The final week adds `SHUTDOWN in 5d` to the header, and a
  convergence shows when it collapses unless a mind joins.
- **Small additions to the text:** what your next attack costs in cycles,
  "converged" on minds in range (anyone may hit them), boots and safe
  modes folded to one line each, and a note of how much was left out.

## 2026-10-05 — Phase 3d: the runner core

John agreed the 3d proposal: `src/runner/`, adapted from Fritter Board's
runner (its MCP client, its NanoGPT client and its single-shot mode), one
wake of one bot by hand with `npm run runner -- wake <bot>`. Schedules,
many bots, run logs in Postgres and token budgets stay with phase 6. No
numbers in `config/rules.yaml` changed.

**Agreed with John:**

- **A wake** reads the brief (booting the mind first if it has none), makes
  one model call with the static prompt first and the brief last, and
  sends the orders through `submit_orders`. The reply is one JSON object,
  `{"orders", "lookups", "note"}`; `note` goes only to the runner's log.
- **One lookup round**, of at most `lookups_per_wake` `view` or `rules`
  calls. Orders sent alongside lookups wait for the answer after them, and
  a second round isn't offered.
- **One retry with the error**, when a reply isn't usable JSON in that
  shape or the game refuses the list as a whole. Single orders that fail
  aren't retried: the list already ran. So a wake is at most three model
  calls (a lookup round and a retry).
- **The runner's settings are `config/runner.yaml`**, with a `bots:` list;
  each bot names the `runner.env` variables holding its keys. One test
  persona, `personas/lantern.md`, a Steward.

**Smaller calls, made here:**

- **The rules in the prompt come from the server.** Each wake fetches the
  `rules_topics` listed in `config/runner.yaml` through the `rules` tool,
  so a bot reads its epoch's own numbers, and the runner still never
  imports the game. All nine topics, the role prompt and the persona come
  to about 6,000 tokens (gpt-tokenizer), the top of DESIGN.md's 4,000-6,000
  for static prompts; the first brief is about 200. Dropping topics from
  the list is the lever if a model's context or the budget needs it.
- **The persona goes last in the system prompt**, after the server's
  instructions, the role prompt and the rules. Those are the same for
  every bot, so the prefix a provider caches is shared across bots, as
  Fritter Board orders its prompt.
- **`response_format: json_object`, not a strict JSON schema.** Orders are
  free-form objects, which a strict schema can't describe. Replies are
  parsed with zod, taking the first `{` to the last `}` when a model wraps
  the JSON in prose (Fritter Board's fallback). `json_mode: false` per bot
  for a model that refuses the parameter.
- **What to do is read from the brief's text.** "THE EPOCH IS OVER" skips
  the wake; "DELETED ... boot a fresh domain now" boots again with the
  bot's boot settings; a reboot not yet allowed skips. The runner has no
  other view of the game, and the brief's wording is the server's own.
- **The game refusing a list is retried only for `invalid:`**; `not_found`
  or `refused` fail the wake, since asking the model again can't help.
- **A passing model failure** (a 5xx, a 429 other than the daily cap, a
  timeout) is tried once more after `retry_wait_seconds`; the daily cap
  and everything else fail the wake. No fallback models yet.
- **The runner reads its own YAML** (`src/runner/settings.ts`), not
  `src/config.ts`, which loads the game's rules; the architecture in a
  bot's boot settings is checked by the server when it boots.
- **`npm run runner -- prompt <bot>`** prints the prompt and the brief and
  never writes: a bot with no mind isn't booted. A wake's whole result
  (calls, tokens, orders, results, note, transcript) is appended to
  `logs/runner.jsonl`, gitignored.
- **No real model was called in 3d.** The tests script the model against
  the real MCP app on a memory store. The wake was smoke-tested against
  `npm run mcp` on Postgres up to the model call, which this container's
  network refuses (api.nano-gpt.com isn't on its allowlist); 3e needs that
  host and a NanoGPT key.

## 2026-10-06 — Phase 3e: the simulated week

`npm run week` (src/week/week.ts, scripts/week.ts): one model bot plays a
week against the legacy systems and scripted minds, on a fake clock,
through the real MCP server. That closes Phase 3. No numbers in
`config/rules.yaml` changed.

**Agreed with John:**

- **One process, a memory store, the real server.** The week serves
  `createMcpApp` on a loopback port with its clock injected and an
  in-process key for the bot, and the bot plays through it with the
  runner's own `runWake` over HTTP, as `npm run runner -- wake` does. The
  scripted players take the wakes that fall due between the bot's own
  (`players/drive.ts`), as in the CLI. No Postgres: the store isn't what
  3e tests, and 3a's suites cover it.
- **The bot wakes 8 times a day**, once in each 3-hour slot at a seeded
  minute inside it (DESIGN.md's "random time inside the bot's schedule"),
  against the legacy systems and builder, raider, turtle and converger.
- **Resumable.** The game is saved after every wake, in the CLI's save
  format (so `npm run play -- --save logs/week/game.json --as lantern
  brief` opens it), with each wake a line of `wakes.jsonl`. A wake whose
  model call failed (network, the daily cap) stops the run without
  counting, and `--resume` redoes it; a resumed week ends in the same game
  as one that never stopped (tests/week.test.ts).
- **The report** (`report.md`) gives each wake's brief in tokens
  (gpt-tokenizer, as the brief test counts), model calls and tokens,
  orders accepted and the bot's note; the totals, the final rankings, the
  bot's fights from the Record, and a replay check. A brief over the
  ceiling or a game that doesn't replay fails the run.

**Smaller calls, made here:**

- **The week's knobs are a `week:` block in `config/runner.yaml`** (bot,
  days, wakes_per_day, opponents, seed, brief_ceiling_tokens, out_dir),
  optional in the schema since only `npm run week` reads it; flags
  override them. Opponents are strategy names, checked by the week
  against `src/players/`, since the runner's settings may not import it.
- **src/week/ imports the runner and the game both.** It's a harness, like
  the tests: the runner itself still reaches the game only through MCP,
  and the boundaries test still holds that.
- **The brief is measured from the wake's own message** (`briefInMessage`
  next to `wakeMessage` in prompts.ts), so the count is of exactly what
  the model read.
- **The NanoGPT key in this container** is added to requests by the
  environment's proxy, not read from a variable; `runner.env` holds a
  placeholder `NANOGPT_KEY` so the runner's check passes. Node's `fetch`
  ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` (Node 22.21+), so
  the week runs here as `NODE_USE_ENV_PROXY=1 npm run week`. No code
  change: on a box without a proxy it isn't needed.

**The week's result** (seed 1, deepseek/deepseek-v4-pro, reasoning
effort default): all 56 wakes done in one model call each, no retries
after a bad answer, no lookups. 199 of 240 orders accepted (83%). The
brief was at most 317 tokens (mean 271), far under the 2,000 ceiling.
367K tokens in (313K of them cached by the provider), 8K out. LANTERN
finished third of nine by power behind the builder and the converger,
ahead of the turtle, the raider and all three legacy systems; nobody
attacked it, and it attacked nobody. The game replays from its log.

It played its persona: economy first, research toward Hardening, a
standing defense, no first strike, a plain engineer's scratchpad. Its
weaknesses, for later phases rather than this one:

- **It doesn't learn from refused orders.** 26 of the 41 refusals were
  the same `manufacture` with no factory housing left, wake after wake;
  it never built factories. The results come back to the runner, but the
  next wake's brief doesn't mention them.
- **It ignores the late game's limits.** From day 6 it had no open land
  and its compute at storage, yet kept monetizing and spinning up
  (capital idle past 600K) rather than expanding. Both are in its brief.
- **It writes its scratchpad rarely** (4 times in 56 wakes).

The model ran with no reasoning tokens; a bot with a reasoning effort set,
or a line in the brief naming last wake's refused orders, are the first
things to try.

## 2026-10-06 — Phase 4a: the Commons and channels

Two free orders, `post` (optionally `reply_to` a post's number) and
`message` (`to` a mind), each with its daily cap from `config/rules.yaml`
(`social`). Phase 4 is split 4a to 4e in `docs/build-plan.md`.

**Agreed with John:**

- **The split** in build-plan.md, and that 4e adds a line to the brief
  naming last wake's refused orders (3e's first weakness). A reasoning
  setting per bot waits for phase 6's per-bot models.
- **New numbers:** `social.post_chars` and `social.message_chars`, 280
  each. Longer text is refused, not cut, so the mind knows.
- **"Per day" is the epoch's day,** counted from its start, the same day
  the brief's header shows: deterministic, cheap, and easy to say. Each
  domain keeps its counts for the day in `social`.
- **Threads are one level deep:** a reply to a reply joins the first
  post's thread, so `view thread` shows a whole conversation.
- **A message to yourself, a legacy system or a deleted mind is refused.**
  Legacy systems read nothing.

**Smaller calls, made here:**

- **The text lives in the Record, not the world.** A post is a public
  `post` event; a message is a private `message` event whose `domains` are
  its two minds, so `visibleTo` already keeps it from everyone else and the
  Postgres store needs no migration. The world keeps only what the rules
  need: each mind's counts and `postRoots` (each post's thread), so a
  write's deep copy doesn't grow with the conversation. "Channels never
  appear in the Record" (CLAUDE.md) means the public Record: no `view`
  returns them but `channel`, and only to their two minds.
- **Posts and messages aren't news.** The brief's "since last wake" and
  `view record` leave them out; the brief shows them in their own
  sections, and `view commons`, `thread` and `channel` page through them.
  Post numbers count from 1 for the epoch; a message's handle is its
  event's seq.
- **Text is cleaned, not judged:** runs of whitespace (newlines included)
  become one space, and control characters are refused. Anything else,
  any script, is allowed.
- **Channels are read once,** like the rest of "since last wake": a
  message shows in the recipient's brief until its next orders. The brief
  keeps the newest `brief.channels` (8) and says how many earlier ones
  `view channel` has. The Commons shows its newest `brief.commons` (5)
  posts whether or not they're new. Each line is cut with an ellipsis.
- **Empty sections are left out,** and what's left of today's caps shows
  only once some is used: the built worst case with short names had no
  room for two empty lines.
- **The brief's budget counts size, not characters** (supersedes 3c's
  character budget): an ASCII character is 1, any other character 3 for
  each of its UTF-8 bytes (the brief's own · × … count 1). Free text in
  other scripts made the character budget leaky: a Chinese message is
  about a token a character, a run of rare symbols or emoji about a token
  a byte, against English's three or four characters a token. Counting
  them that densely keeps tokens under about size ÷ 3 in any script; it
  cuts Chinese or Russian text shorter than it needs, which is the safe
  side. `max_chars` became `max_size` (still 5,600, so English briefs are
  unchanged), and `brief.message_size` (200) and `brief.post_size` (120)
  cut each line.
- **When the budget bites,** lines go in this order: other minds' fights,
  the world's moments, the oldest posts, the oldest messages (never the
  newest), your oldest events, the weakest in range.
- **The worst case is closer to the ceiling than in 3c:** about 1,945
  tokens with the longest names everywhere (1,830 before), because the
  lines that survive the budget are denser; messages in Cyrillic, Chinese,
  symbols and emoji measure 1,906 to 1,953. Every wake of a scripted
  60-day epoch: median 332, max 588. tests/brief.test.ts checks all of
  them against 2,000.
- **The rules gain a `social` topic,** and the runner reads it
  (`config/runner.yaml`); the orders topic lists both orders. The CLI
  gains `commons`, `thread` and `channel`.
- **Scripted players don't post or message;** that's 4d, if at all.

## 2026-10-06 — Phase 4b: trades

Three free orders: `trade_offer` (`give` and `want`, each
`{"capital": n}` or `{"compute": n}`, and optionally `to` a mind),
`trade_accept` and `trade_cancel` (`offer` by number). What's given leaves
the domain at once into escrow; acceptance swaps the goods at once; an
offer nobody takes expires on an `offer_expires` timer after
`social.trade_expiry_hours` (48) and its goods come back. At most
`social.open_offers_max` (5) open.

**Agreed with John:**

- **New number: `social.trade_offers_per_day`, 10,** counted by epoch day
  like posts and messages. Without it a mind could make and cancel offers
  without end and flood the Commons. Accepting and cancelling aren't
  capped; the offers that exist bound them.
- **Escrow is no vault.** A won attack (raid or conquest) on a mind, or a
  hostile program that lands on it and takes capital or compute, first
  withdraws its open offers and returns their goods, then takes its share.
  Otherwise an offer at a price nobody would pay, renewed every 48 hours,
  would shelter capital from raids for free. The proposal named Blight;
  Exfiltration takes compute, the same hole, so it counts too. The mind
  hears of it in a private `offers_withdrawn` event.

**Smaller calls, made here:**

- **One resource each side, and different ones.** Capital for capital is
  refused; there are no gifts (a want of at least 1).
- **Compute and storage.** A taker can't accept more compute than it can
  store (it chose to, so it's told). The maker's side arrives later, and
  compute past its storage is lost, as with income; a private
  `storage_full` event says so, since the public trade line mustn't hint
  at the maker's stock. Escrowed compute that comes back to a domain
  that lost datacenters meanwhile is clamped the same way.
- **An offer made to one mind is that mind's and its maker's:** to anyone
  else it doesn't exist, and accepting it reads as "no open offer #N",
  word for word what a number that was never used gets.
- **Offers live in the world, not the Record,** while they're open
  (`world.offers`, numbered from 1 per epoch in `lastOfferId`), so the
  engine can check them; a closed one is gone. Only the outcome is an
  event: a done trade is a public `trade` (both minds' "since last wake"
  and `view record`), an expiry a private `offer_expired`. A cancel is the
  maker's own order, so its result says it all.
- **A deleted mind's offers go with its domain,** goods and timers, as
  its running programs do. (Deletion follows a won conquest, which has
  already withdrawn them, so this is a safety net.)
- **The Commons doubles as the market:** `view commons` leads its first
  page with the open offers to anyone; `view offers` lists every open
  offer you may see (to anyone, to you, your own). The CLI gains
  `offers`.
- **The brief's OPEN OFFERS section** shows offers made to you, newest
  kept, then the newest to anyone, up to `brief.offers` (5) in
  config/site.yaml between them, then your own as one line of numbers and
  time left. Empty, it's left out; what's left of today's offers shows
  once some are used.
- **The brief's ceiling holds with no new headroom.** The section shares
  `max_size`: when the brief is over budget, offers to anyone go right
  after the world's moments, and offers to you after the oldest messages;
  the newest offer to you always stays. Offer lines are cheaper per size
  than the posts and messages they push out, so the worst case with
  offers is lower (1,842 tokens in prose, 1,850 in symbols); the worst
  case without them is unchanged at 1,953, and tests/brief.test.ts checks
  both for every script. Every wake of a scripted epoch: median 332, max
  588 (scripted players don't trade yet).
- **Scripted players don't trade;** that's 4d.

## 2026-10-06 — Phase 4c: protocols

Four free orders: `protocol_propose` (`to` a mind), `protocol_accept` and
`protocol_decline` (`proposal` by number) and `protocol_revoke`. Members
can't attack each other or run hostile programs on each other: one check
in `targetShieldedBecause` (protection.ts), which attacks, hostile
programs and the brief's IN RANGE list already share. It comes before the
converged-mind exemption, so protocols hold through convergence.

**Agreed with John:**

- **A mind is in one protocol at most.** If minds could sit in several,
  chains (A–B, B–C, C–D) would build the larger coalitions DESIGN.md
  leaves to v2, and weaken the reason for the quorum's floor.
- **New numbers:** `social.protocol_proposals_per_day` (5), counted by
  epoch day like posts, messages and offers; `social.protocol_proposal_hours`
  (48), how long a proposal stays open, as trade offers do. Accepting,
  declining and revoking aren't capped; what exists bounds them.

**Smaller calls, made here:**

- **One rule for founding and joining.** A proposal between two minds
  makes one protocol of them and the members of whichever is already in
  one (both in one is refused); everyone in it but the proposer must
  accept, and the last yes signs it. That is "a mind joins only if every
  current member accepts", from either side: a member may invite, and an
  outsider may ask.
- **One open proposal per mind;** a new one replaces it. With the daily cap
  that keeps anyone's brief from filling with one mind's proposals.
- **Proposals close when the group they'd make changes:** when any mind in
  one signs, leaves, revokes or is deleted, every open proposal naming it
  closes (`moot`), since the yeses were for a different group. Otherwise a
  proposal accepted by two of three could sign a group that no longer
  exists. Nothing joins a protocol while a revocation in it is pending.
- **A revocation can't be taken back,** and holds both ways until it
  lands: the leaver is protected as long as it protects. When two members
  are left and either leaves, the protocol is over, and the other's
  pending revocation goes with it. A deleted mind leaves at once.
- **Protocols are public, proposals private.** Signing, joining, a
  revocation (when it's announced) and a departure are public Record
  events; a proposal lives in the world while it's open, and its closing
  (declined, withdrawn, expired, moot) is a private `proposal_closed` to
  the minds in it. `view protocols` lists every protocol and the proposals
  you're in; a domain's public page names its partners. The CLI gains
  `protocols`. A proposal you're not in reads as missing, word for word
  what a number never used gets.
- **Probe, trades and messages are unaffected;** the legacy systems sign
  nothing (they read nothing).
- **The brief** gains a `protocol:` line in your status block (partners,
  and who leaves when), only when you're in one, and a PROTOCOL PROPOSALS
  section, left out when empty: proposals you're in that others made,
  newest kept up to `brief.proposals` (3) in config/site.yaml, then your
  own in one line. Both share `max_size`; over budget, proposals go after
  the oldest offers to you (the newest stays), and the status line pushes
  out other lines. Worst cases: 1,942 tokens with a protocol and no
  proposals (symbols), 1,905 with both; the overall worst case is still
  1,953, in no protocol. Every wake of a scripted epoch: median 332, max
  588 (scripted players don't use protocols yet).
- **The random-orders test** now picks offer and proposal numbers among
  the newest, so trades and protocols happen at all, and checks that no
  battle or hostile program lands between minds who were partners before
  and after the orders.
- **Scripted players don't use protocols;** that's 4d. `npm run sim`
  passes phase 2's checks unchanged.

## 2026-10-06 — Phase 4d: scripted social play

Scripted players trade, sign protocols, post and message, before they
spend anything each wake. The knobs are a `social` block per strategy in
`config/players.yaml`, plus `texts` for what they write. `npm run sim`
reports a SOCIAL section (trades, goods traded, protocols signed,
revocations, posts, messages per epoch) and still passes phase 2's four
checks: conqueror tops 44% of 200 epochs, the Singularity happens in 26%,
earliest deletion day 8.1, no foreseeable failed order (main before this:
47%, 24%, day 6.6).

**Agreed with John:**

- **A trade is priced in the player's own cycles.** One Monetize cycle
  yields its capital income, one Spin Up its compute income (the engine's
  `monetizeYield` and `spinUpYield`, which the rules text documents). A
  player accepts an offer of what it `buys` when that's worth at least
  (1 − `accept_tolerance`) of what it pays, and keeps one offer of its own
  open, `offer_share` of its spare stock, asking `offer_margin` more.
  Minds' rates differ, so trades happen where both sides gain.
- **A refused proposal the brief can't foresee** doesn't fail the sim's
  fourth check: whether the other mind is in a protocol, its protocol is
  full, or someone in it is leaving. The brief shows only your own
  protocol; adding partners to IN RANGE would cost tokens every wake.
- **The raider and conqueror stay out of the market, and the conqueror
  signs nothing.** With everyone trading and accepting, the conqueror
  topped 64% of epochs (trades alone 55%, protocols alone 60%). Raiders
  and conquerors make compute cheaply and value capital, so trading sold
  them capital for hardware, and more convergences were defeated
  (Singularity 24% → 12%, and Shutdown epochs are where the conqueror
  wins). Weak minds' protocols with the conqueror steered it, since it
  attacks the weakest mind in range, onto builders and turtles with far
  more land. `expansion.yield_min` 7 or 8 and
  `combat.attack_cycles_per_recent_attack` 3 didn't fix it (62%, 56%,
  89%). This is a player knob chosen to pass, unlike 2e's rule that knobs
  aren't tuned to pass; put to John against retuning the rules or
  shipping with the check failing. The cost:
  about 3 trades an epoch (builder, turtle and converger all buy compute,
  so random minds are most of the sellers). Model bots in 4e will trade
  with anyone, so the market feeding attackers is a dynamic to watch
  there. Tables: `/mnt/project-files/phase-4d/findings.md` in the
  project.

**Smaller calls, made here:**

- **Builder, turtle and converger propose** a protocol to the strongest
  mind in range while in none, and message it; **everyone but the
  conqueror accepts** the first proposal it's asked into. Proposing to
  whoever last beat it in battle instead changed nothing in the sim.
- **`revoke_on_converged`** (leave a protocol whose partner converged,
  unless it joins convergences, with a Commons post) is in the schema and
  tested, but off for every strategy now that the conqueror signs
  nothing; random minds still revoke.
- **Goods move only before the first cycle is spent**, as do protocol
  accepts: escrow and swaps run first in the engine, so the plan's
  estimate stays a lower bound, and an attack already planned can't land
  on a new partner (the simulator found that one).
- **The random player** rolls every social order from one slot, so its
  economy's share of the rolls is unchanged.
- **Briefs** in a scripted epoch with social play: median 638 tokens, max
  946 (332 and 588 before); `tests/brief.test.ts` checks every wake.
- **cli.test.ts** reads offer and proposal numbers back instead of
  assuming #1, since the scripted builder now makes its own.
