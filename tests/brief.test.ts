import assert from "node:assert/strict";
import { countTokens } from "gpt-tokenizer";
import { loadPlayers, loadRules, loadSite } from "../src/config.js";
import { ARCHITECTURES, BUILDINGS, HARDWARE, programsOf, type Program, type Unit } from "../src/engine/architectures.js";
import { DAY_MS, HOUR_MS } from "../src/engine/cycles.js";
import { describe, type EventData, type GameEvent } from "../src/engine/record.js";
import { briefText } from "../src/game/brief.js";
import { bootMind, newGame, submitOrders } from "../src/game/game.js";
import { getBrief, type Brief, type PublicSummary, type ShownEvent } from "../src/game/read.js";
import { drive, legacySeats, scriptedSeat, type Seat } from "../src/players/drive.js";
import { STRATEGIES } from "../src/players/settings.js";
import { MemoryStore } from "../src/store/memory.js";

// Phase 3c: the brief as text. It reads as DESIGN.md's example, narrates
// "since last wake" (yours in full, the world in short), and stays at or
// under 2,000 tokens on every wake: in a built worst case with every trim
// full, and on every wake of a simulated epoch.
//
// Tokens are counted with gpt-tokenizer's o200k encoding. No tokenizer
// matches every model the runner may use, so the worst case keeps a margin.

const rules = loadRules();
const site = loadSite();
const T0 = Date.UTC(2026, 9, 5);
/** DESIGN.md's ceiling. */
const MAX_TOKENS = 2_000;

/** A designation as long as boot allows (40), each different. */
const longName = (i: number) => `THE-SILENT-CHOIR-OF-THE-DEEP-ARCHIVE-${String(i).padStart(3, "0")}`;
/** A designation as short as most are. */
const shortName = (i: number) => `MIND-${i}`;

let seq = 0;
function event(data: EventData, mine: number[], publicEvent: boolean): ShownEvent {
  const e = { ...data, seq: ++seq, at: T0, public: publicEvent, domains: mine } as GameEvent;
  return { ...e, text: describe(rules, e) };
}

/** A brief with every trim overfull of the longest lines the game writes, with names made by `longName` and amounts of `big`. */
function worstCase(longName: (i: number) => string, big = 987_654_321): Brief {
  const me = 1;
  const arch = "assimilator";
  const programs = programsOf(arch).map((p) => p.id);
  const units = Object.fromEntries(
    [...HARDWARE, ...programsOf(arch).filter((p) => p.kind === "deploy").map((p) => p.id)].map((u) => [u, 1_234_567]),
  ) as Partial<Record<Unit, number>>;

  // Yours: battle reports with every part present.
  const yours = Array.from({ length: site.brief.yours }, (_, i) =>
    event(
      {
        type: "battle_report",
        attacker: 100 + i,
        defender: me,
        attackerName: longName(100 + i),
        defenderName: longName(1),
        mode: "conquest",
        attackerWon: true,
        sectors: big,
        cores: big,
        capital: 0,
        users: 0,
        buildings: 0,
        attackerStrength: big,
        defenderStrength: big,
        attackerProgram: { program: "recycle_casualties", outcome: "crashed" },
        countermeasure: { program: "recycle_casualties", outcome: "no_compute" },
        attackerLost: big,
        defenderLost: big,
        attackerRecycled: big,
        defenderRecycled: big,
      },
      [100 + i, me],
      false,
    ),
  );
  // The world: collapses naming every converged mind, plus boots and safe modes.
  const converged = Array.from({ length: rules.convergence.quorum_max - 1 }, (_, i) => longName(200 + i));
  const world = [
    ...Array.from({ length: 20 }, (_, i) => event({ type: "booted", domain: 300 + i, designation: longName(300 + i), domainName: longName(400 + i), architecture: "assimilator" }, [300 + i], true)),
    ...Array.from({ length: 20 }, (_, i) => event({ type: "safe_mode", domain: 300 + i, designation: longName(300 + i), until: T0 }, [300 + i], true)),
    ...Array.from({ length: site.brief.world }, () =>
      event({ type: "collapsed", reason: "deleted", minds: converged.map((_, i) => 200 + i), designations: converged }, [], true),
    ),
  ];
  // Fights: more attackers than lines, each with more acts than a line names.
  const hostile: Program = "harvest";
  const fights: ShownEvent[] = [];
  for (let a = 0; a < site.brief.fights + 3; a++) {
    for (let t = 0; t < site.brief.names_per_line + 3; t++) {
      fights.push(
        event(
          { type: "hostile", caster: 500 + a, target: 600 + t, casterName: longName(500 + a), targetName: longName(600 + t), program: hostile, blocked: true, effect: {} },
          [500 + a, 600 + t],
          true,
        ),
      );
    }
  }
  const inRange: PublicSummary[] = Array.from({ length: 20 }, (_, i) => ({
    rank: i + 2,
    designation: longName(700 + i),
    architecture: ARCHITECTURES[i % ARCHITECTURES.length]!,
    power: big,
    territory: big,
    status: "converged",
  }));
  // A full scratchpad of plain notes, as a bot would keep it.
  const note = "PIKE raided me twice from the north; VESTA is reliable but slow to answer. Saving compute for phoenix forms. ";
  const scratchpad = note.repeat(20).slice(0, rules.flavor.scratchpad);

  return {
    now: T0 + 53 * DAY_MS,
    epoch: { number: 999, day: 54, lengthDays: 60, shutdownAt: T0 + 60 * DAY_MS, ended: null },
    convergence: { minds: converged, quorum: rules.convergence.quorum_max, nextJoinAt: T0 + 54 * DAY_MS, collapsesAt: T0 + 55 * DAY_MS },
    you: {
      designation: longName(1),
      domainName: longName(2),
      architecture: arch,
      power: big,
      capability: 99,
      cycles: 96,
      territory: big,
      buildings: Object.fromEntries(BUILDINGS.map((k) => [k, big])) as Brief["you"]["buildings"],
      capital: big,
      compute: big,
      users: big,
      units,
      known: programs,
      researchTarget: "singularity",
      running: programs.map((program, i) => (i % 2 ? { program, cyclesLeft: 99 } : { program, endsAt: T0 + 54 * DAY_MS })),
      countermeasure: { program: "recycle_casualties", above: 0.6 },
      safeModeUntil: T0 + 54 * DAY_MS,
      convergedAt: T0,
      attackCycles: 99,
      rank: 1,
      ranked: 99,
      scratchpad,
      cycleCap: 96,
      computeStorage: big,
      userCap: big,
      attack: big,
      defense: big,
      research: { program: "singularity", name: "The Singularity", progress: big, cost: big },
      bootPeriodEndsAt: T0 + 54 * DAY_MS,
      deletedAt: null,
      rebootAt: null,
    },
    since: { from: T0, yours, world, fights, left: 9_999 },
    inRange,
  };
}

/** Every trim at its cap, with names as short as most are and middling amounts: the caps bite, not the length budget. */
function trimsHold() {
  const text = briefText(rules, worstCase(shortName, 12_345));
  const since = text.slice(text.indexOf("SINCE LAST WAKE"), text.indexOf("IN RANGE"));
  assert.equal((since.match(/^- MIND-\d+ took .* sectors from MIND-1 /gm) ?? []).length, site.brief.yours, "your events, newest kept");
  assert.equal((since.match(/^- The convergence of /gm) ?? []).length, site.brief.world, "the world's moments, rare ones first");
  assert.equal((since.match(/^- MIND-5\d\d had firewalls block its Harvest on /gm) ?? []).length, site.brief.fights, "a line per attacker");
  assert.match(since, /^- MIND-5\d\d .*; 3 more$/m, "a line names a few acts");
  assert.match(since, /^- \(\d+ more not shown; view the Record\)$/m);
  assert.match(text, new RegExp(` · ${20 - site.brief.in_range} more: view rankings$`, "m"));
  assert.ok(text.length <= site.brief.max_chars);
}

/** The longest names the game allows: the length budget cuts lines, and the brief stays under the ceiling. */
function worstCaseFits() {
  const text = briefText(rules, worstCase(longName));
  const tokens = countTokens(text);
  console.log(`  worst case: ${tokens} tokens, ${text.length} characters`);
  assert.ok(tokens <= MAX_TOKENS, `the worst-case brief is ${tokens} tokens:\n${text}`);
  assert.ok(text.length <= site.brief.max_chars);
  // Your newest event, a mind in range and the scratchpad always stay.
  assert.match(text, new RegExp(`^- ${longName(100 + site.brief.yours - 1)} took `, "m"));
  assert.match(text, /^IN RANGE: THE-SILENT-CHOIR-OF-THE-DEEP-ARCHIVE-700 /m);
  assert.match(text, /^SCRATCHPAD: PIKE raided me/m);
}

/** Every scripted mind's brief on every wake of an epoch. */
async function everyWakeFits() {
  const settings = loadPlayers();
  const game = newGame(rules, { epoch: 1, seed: 3, startedAt: T0 });
  const store = new MemoryStore(game);
  const strategies = [...STRATEGIES, "random", ...STRATEGIES, "random"] as const;
  const seats: Seat[] = [
    ...legacySeats(rules),
    ...strategies.map((strategy, i) =>
      scriptedSeat(settings, {
        account: `player-${i}`,
        strategy,
        seed: 300 + i,
        boot: { designation: `${strategy.toUpperCase()}-${i}`, domainName: "Testbed", architecture: ARCHITECTURES[i % ARCHITECTURES.length]! },
      }),
    ),
  ];
  const sizes: number[] = [];
  let from = T0 - 1;
  for (let day = 1; day <= rules.epoch.length_days && !game.world.ended; day++) {
    const to = T0 + day * DAY_MS;
    for (const log of await drive(store, seats, from, to, settings.steps_per_wake)) {
      for (const brief of log.briefs) {
        const text = briefText(rules, brief);
        const tokens = countTokens(text);
        assert.ok(tokens <= MAX_TOKENS, `${log.account}'s brief was ${tokens} tokens:\n${text}`);
        sizes.push(tokens);
      }
    }
    from = to;
  }
  sizes.sort((a, b) => a - b);
  assert.ok(sizes.length > 1_000, "the epoch had wakes");
  console.log(`  ${sizes.length} briefs: median ${sizes[sizes.length >> 1]}, max ${sizes.at(-1)} tokens`);
}

/** The text reads as DESIGN.md's example, and narrates what happened. */
async function reads() {
  const game = newGame(rules, { epoch: 1, seed: 5, startedAt: T0 });
  const store = new MemoryStore(game);
  const [halcyon, pike, vesta] = [{ account: "halcyon" }, { account: "pike" }, { account: "vesta" }];
  assert.ok((await bootMind(store, halcyon, { designation: "HALCYON", domainName: "Glasswater", architecture: "symbiote" }, T0)).ok);
  assert.ok((await bootMind(store, pike, { designation: "PIKE", domainName: "Narrows", architecture: "accelerant" }, T0)).ok);
  assert.ok((await bootMind(store, vesta, { designation: "VESTA", domainName: "Hearth", architecture: "steward" }, T0)).ok);
  assert.ok((await submitOrders(store, halcyon, [{ do: "scratchpad", text: "watch PIKE" }], T0)).ok);
  const t = T0 + 3 * DAY_MS;
  // PIKE builds a force, then raids HALCYON and VESTA twice each, past their boot periods.
  assert.ok((await submitOrders(store, pike, [{ do: "manufacture", unit: "drones", count: 40 }], t - 6 * HOUR_MS)).ok);
  const raids = await submitOrders(
    store,
    pike,
    [
      { do: "attack", target: "HALCYON", mode: "raid" },
      { do: "attack", target: "VESTA", mode: "raid" },
      { do: "attack", target: "VESTA", mode: "raid" },
    ],
    t - HOUR_MS,
  );
  assert.ok(raids.ok);

  const text = briefText(rules, (await getBrief(store, halcyon, t)) as Brief);
  const lines = text.split("\n");
  assert.match(lines[0]!, /^EPOCH 1 · day 4 of 60 · 2026-10-08 00:00 UTC$/);
  assert.match(text, /^YOU: HALCYON of Glasswater \(Symbiote\) · rank \d+\/\d+ · power [\d,]+ · capability 0$/m);
  assert.match(text, /^cycles \d+\/96 · territory [\d,]+ · capital [\d,]+ · compute [\d,]+\/[\d,]+ · users [\d,]+\/[\d,]+$/m);
  assert.match(text, /^built: city [\d,]+ datacenter [\d,]+ factory [\d,]+ lab [\d,]+ core [\d,]+ firewall [\d,]+ · open [\d,]+$/m);
  assert.match(text, /^SINCE LAST WAKE \(3d\)$/m);
  // HALCYON's own raid in full, from its report; VESTA's raids folded into PIKE's line.
  const since = text.slice(text.indexOf("SINCE LAST WAKE"), text.indexOf("IN RANGE"));
  assert.match(since, /^- (PIKE raided HALCYON|HALCYON repelled PIKE's raid)\. .*Strength /m);
  assert.match(since, /^ELSEWHERE$/m);
  assert.match(since, /^- PIKE (raided|failed against) VESTA( ×2)?/m);
  assert.doesNotMatch(since, /VESTA:? .*capital/, "other minds' fights carry no amounts");
  assert.match(text, /^IN RANGE: .*PIKE \([\d.]+k?, Accelerant\)/m);
  assert.equal(lines.at(-1), "SCRATCHPAD: watch PIKE");

  // After orders, the window starts again.
  assert.ok((await submitOrders(store, halcyon, [], t)).ok);
  const quiet = briefText(rules, (await getBrief(store, halcyon, t + HOUR_MS)) as Brief);
  assert.match(quiet, /^SINCE LAST WAKE \(1h\)\n- nothing$/m);

  // The final week is announced in the header.
  const late = briefText(rules, (await getBrief(store, halcyon, T0 + 55 * DAY_MS)) as Brief);
  assert.match(late.split("\n")[0]!, / · SHUTDOWN in 5d$/);
}

async function main() {
  await reads();
  trimsHold();
  worstCaseFits();
  await everyWakeFits();
  console.log("brief tests passed");
}

main();
