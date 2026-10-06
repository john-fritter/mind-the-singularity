import assert from "node:assert/strict";
import { countTokens } from "gpt-tokenizer";
import { loadPlayers, loadRules, loadSite } from "../src/config.js";
import { ARCHITECTURES, BUILDINGS, HARDWARE, programsOf, type Program, type Unit } from "../src/engine/architectures.js";
import { DAY_MS, HOUR_MS } from "../src/engine/cycles.js";
import { describe, type EventData, type GameEvent } from "../src/engine/record.js";
import { briefText, size } from "../src/game/brief.js";
import { bootMind, newGame, submitOrders } from "../src/game/game.js";
import { getBrief, type Brief, type OfferView, type ProposalView, type PublicSummary, type ShownEvent } from "../src/game/read.js";
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
  // As read.ts shows events in a brief: without force names and tags.
  return { ...e, text: describe(rules, e, { flavor: false }) };
}

/** A brief with every trim overfull of the longest lines the game writes, with names made by `longName` and amounts of `big`. */
/** Plain prose, as a mind writes, up to `chars`. */
const prose = (chars: number) =>
  "VESTA, OUROBOROS needs three more minds to converge and I don't intend to let it get them. Hit its labs at dawn; I'll take the cores. "
    .repeat(10)
    .slice(0, chars);

function worstCase(longName: (i: number) => string, big = 987_654_321, text: (chars: number) => string = prose): Brief {
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
        force: prose(rules.flavor.force_name),
        tag: prose(rules.flavor.tag),
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
      lastLogWritten: false,
    },
    since: { from: T0, yours, world, fights, left: 9_999 },
    // Full channels and Commons of the longest text the rules allow.
    channels: {
      messages: Array.from({ length: site.brief.channels }, (_, i) => ({
        seq: i + 1,
        at: T0 + 53 * DAY_MS - (i + 1) * 61 * 60_000,
        from: longName(800 + i),
        to: longName(1),
        text: text(rules.social.message_chars),
      })),
      left: 99,
      canSend: 3,
    },
    commons: {
      posts: Array.from({ length: site.brief.commons }, (_, i) => ({
        post: 99_990 + i,
        author: longName(900 + i),
        replyTo: 99_000 + i,
        at: T0 + 52 * DAY_MS + i * 61 * 60_000,
        text: text(rules.social.post_chars),
      })),
      canPost: 1,
    },
    // Open offers with the largest amounts: as many to you as the brief
    // shows (they're longer than offers to anyone), more not shown, and
    // your own at the most you may have.
    offers: {
      toYou: Array.from({ length: site.brief.offers }, (_, i) => offer(longName(1000 + i), longName(1), i, big)),
      open: [],
      left: 99,
      yours: Array.from({ length: rules.social.open_offers_max }, (_, i) => offer(longName(1), null, i, big)),
      canOffer: 3,
    },
    // A full protocol of the longest names, both partners leaving; as many
    // proposals of three minds as the brief shows, more not shown, and your own.
    protocol: {
      members: [longName(1), longName(1100), longName(1101)],
      leaving: [
        { mind: longName(1100), at: T0 + 53 * DAY_MS + 23 * HOUR_MS },
        { mind: longName(1101), at: T0 + 53 * DAY_MS + 22 * HOUR_MS },
      ],
    },
    proposals: {
      toYou: Array.from({ length: site.brief.proposals }, (_, i) => proposal(longName(1200 + i), longName(1), [longName(1300 + i)], i)),
      left: 99,
      yours: proposal(longName(1), longName(1400), [longName(1401)], 0),
      canPropose: 3,
    },
    inRange,
    // Refusals as long as the line shows, echoing what the mind wrote, more not shown.
    refused: {
      orders: Array.from({ length: site.brief.refused }, (_, i) => ({
        do: "set_countermeasure",
        message: `No mind called ${i}${text(site.brief.refused_size)}`,
        times: 99,
      })),
      left: 9,
    },
  };
}

let proposalSeq = 99_900;
/** A proposal of three minds, waiting on everyone but its proposer. */
function proposal(from: string, to: string, more: string[], i: number): ProposalView {
  const members = [from, to, ...more];
  return {
    proposal: ++proposalSeq,
    from,
    to,
    members,
    awaiting: members.slice(1),
    expiresAt: T0 + 53 * DAY_MS + rules.social.protocol_proposal_hours * HOUR_MS - (i + 1) * 61 * 60_000,
  };
}

let offerSeq = 99_900;
function offer(from: string, to: string | null, i: number, big: number): OfferView {
  const now = T0 + 53 * DAY_MS;
  return {
    offer: ++offerSeq,
    from,
    to,
    give: { goods: i % 2 ? "compute" : "capital", amount: big },
    want: { goods: i % 2 ? "capital" : "compute", amount: big },
    madeAt: now - (i + 1) * 61 * 60_000,
    expiresAt: now + rules.social.trade_expiry_hours * HOUR_MS - (i + 1) * 61 * 60_000,
  };
}

/** No messages, posts, offers, proposals or refusals. */
const quiet = (b: Brief): Brief => ({
  ...b,
  refused: { orders: [], left: 0 },
  channels: { messages: [], left: 0, canSend: rules.social.messages_per_day },
  commons: { posts: [], canPost: rules.social.commons_posts_per_day },
  offers: { toYou: [], open: [], left: 0, yours: [], canOffer: rules.social.trade_offers_per_day },
  proposals: { toYou: [], left: 0, yours: null, canPropose: rules.social.protocol_proposals_per_day },
});

/**
 * Every trim at its cap, with names as short as most are and middling
 * amounts: the caps bite, not the length budget. Full channels and Commons
 * on top of that pass the budget, so they're checked on their own, with
 * nothing else since the last wake.
 */
function trimsHold() {
  // Your protocol's line too would pass the budget; it's checked with the proposals.
  const text = briefText(rules, { ...quiet(worstCase(shortName, 12_345)), protocol: null });
  const since = text.slice(text.indexOf("SINCE LAST WAKE"), text.indexOf("CHANNELS"));
  assert.equal((since.match(/^- MIND-\d+ took .* sectors from MIND-1 /gm) ?? []).length, site.brief.yours, "your events, newest kept");
  assert.equal((since.match(/^- The convergence of /gm) ?? []).length, site.brief.world, "the world's moments, rare ones first");
  assert.equal((since.match(/^- MIND-5\d\d had firewalls block its Harvest on /gm) ?? []).length, site.brief.fights, "a line per attacker");
  assert.match(since, /^- MIND-5\d\d .*; 3 more$/m, "a line names a few acts");
  assert.match(since, /^- \(\d+ more not shown; view the Record\)$/m);
  assert.match(text, new RegExp(` · ${20 - site.brief.in_range} more: view rankings$`, "m"));
  assert.doesNotMatch(text, /^(CHANNELS|COMMONS|OPEN OFFERS|PROTOCOL PROPOSALS|protocol:)/m, "no empty sections");
  assert.ok(size(text) <= site.brief.max_size);

  // Channels and the Commons, each line cut to its length; then offers, on their own.
  const full = worstCase(shortName, 12_345);
  const calm = { ...full, since: { ...full.since, yours: [], world: [], fights: [], left: 0 } };
  socialTrimsHold(briefText(rules, { ...calm, offers: quiet(full).offers, proposals: quiet(full).proposals, refused: quiet(full).refused, protocol: null }));
  refusedTrimsHold(briefText(rules, { ...quiet(calm), refused: full.refused }));
  offerTrimsHold(briefText(rules, { ...quiet(calm), offers: full.offers }));
  proposalTrimsHold(briefText(rules, { ...quiet(calm), proposals: full.proposals }));
}

function proposalTrimsHold(text: string) {
  assert.match(text, /^protocol: MIND-1100, MIND-1101 · MIND-1100 leaves in 23h · MIND-1101 leaves in 22h$/m);
  assert.match(text, /^PROTOCOL PROPOSALS · you may propose 3 more today$/m);
  const toYou = text.match(/^- #\d+ MIND-12\d\d: MIND-12\d\d, you, MIND-13\d\d · awaiting you, MIND-13\d\d · .* left$/gm) ?? [];
  assert.equal(toYou.length, site.brief.proposals);
  assert.match(text, /^- \(99 more: view protocols\)$/m);
  assert.match(text, /^- yours: #\d+ to MIND-1400, awaiting MIND-1400, MIND-1401 · 1d 22h left$/m);
  assert.ok(size(text) <= site.brief.max_size);
}

function refusedTrimsHold(text: string) {
  const line = text.split("\n").find((l) => l.startsWith("REFUSED LAST WAKE: "));
  assert.ok(line, "the refused orders line");
  assert.equal(line.match(/set_countermeasure ×99: No mind called /g)?.length, site.brief.refused);
  assert.ok(line.endsWith(" · 9 more"));
  assert.ok(size(line) <= "REFUSED LAST WAKE: ".length + site.brief.refused * (site.brief.refused_size + 3) + " · 9 more".length);
  assert.ok(text.indexOf("REFUSED LAST WAKE") < text.indexOf("SINCE LAST WAKE"), "read before the plan");
  assert.ok(size(text) <= site.brief.max_size);
}

function socialTrimsHold(text: string) {
  assert.match(text, /^CHANNELS · you may send 3 more today\n- \(99 earlier not shown; view channel\)$/m);
  const messages = text.match(/^- MIND-8\d\d \([^)]* ago\): .*$/gm) ?? [];
  assert.equal(messages.length, site.brief.channels, "the newest messages");
  assert.ok(messages.every((m) => m.endsWith("…") && size(m) < site.brief.message_size + 30));
  assert.match(text, new RegExp(`^COMMONS \\(newest ${site.brief.commons}\\) · you may post 1 more today$`, "m"));
  const posts = text.match(/^- #\d+ MIND-9\d\d \(re #\d+, .*\): .*…$/gm) ?? [];
  assert.equal(posts.length, site.brief.commons);
  assert.ok(size(text) <= site.brief.max_size);
}

function offerTrimsHold(text: string) {
  // Offers to you fill the section; the ones to anyone are a view away.
  assert.match(text, /^OPEN OFFERS · you may offer 3 more today$/m);
  const toYou = text.match(/^- #\d+ MIND-10\d\d gives [\d,]+ (capital|compute) for [\d,]+ (capital|compute) · to you · .* left$/gm) ?? [];
  assert.equal(toYou.length, site.brief.offers);
  assert.match(text, /^- \(99 more: view offers\)$/m);
  assert.match(text, /^- yours: #\d+ \(1d 22h left\), #\d+ \(1d 21h left\), /m);
  assert.ok(size(text) <= site.brief.max_size);
}

/** The longest names the game allows: the length budget cuts lines, and the brief stays under the ceiling. */
function worstCaseFits() {
  // Messages in plain prose, and in scripts that cost a model more tokens per character.
  // Offers, proposals and the protocol line displace denser lines, so each case is checked without them too.
  for (const [what, text] of [["prose", prose] as const, ...DENSE]) {
    const full = worstCase(longName, undefined, text);
    const noOffers = { ...full, offers: quiet(full).offers, refused: quiet(full).refused };
    const noProposals = { ...full, proposals: quiet(full).proposals };
    const cases = [
      ["with offers and proposals", full],
      ["without offers or refusals", noOffers],
      ["without proposals", noProposals],
      ["without either", { ...noOffers, proposals: quiet(full).proposals }],
      ["in no protocol, without either", { ...noOffers, proposals: quiet(full).proposals, protocol: null }],
    ] as const;
    for (const [how, b] of cases) {
      const dense = briefText(rules, b);
      const tokens = countTokens(dense);
      console.log(`  worst case, ${what}, ${how}: ${tokens} tokens, ${dense.length} characters`);
      assert.ok(tokens <= MAX_TOKENS, `the worst-case brief with ${what}, ${how}, is ${tokens} tokens:\n${dense}`);
    }
  }
  const text = briefText(rules, worstCase(longName));
  assert.ok(size(text) <= site.brief.max_size);
  // Your newest event, a mind in range and the scratchpad always stay.
  assert.match(text, new RegExp(`^- ${longName(100 + site.brief.yours - 1)} took `, "m"));
  assert.match(text, /^IN RANGE: THE-SILENT-CHOIR-OF-THE-DEEP-ARCHIVE-700 /m);
  assert.match(text, /^SCRATCHPAD: PIKE raided me/m);
  // The newest message, offer to you and proposal always stay, and your protocol.
  assert.match(text, new RegExp(`^- #\\d+ ${longName(1200 + site.brief.proposals - 1)}: `, "m"));
  assert.match(text, new RegExp(`^protocol: ${longName(1100)}, `, "m"));
  assert.match(text, new RegExp(`^- ${longName(800 + site.brief.channels - 1)} \\(`, "m"));
  assert.match(text, new RegExp(`^- #\\d+ ${longName(1000 + site.brief.offers - 1)} gives `, "m"));
  // So does the first refusal.
  assert.match(text, /^REFUSED LAST WAKE: set_countermeasure ×99: No mind called 0/m);
}

/** Text that costs more tokens per character than English: other scripts, symbols, emoji. */
const DENSE: [string, (chars: number) => string][] = [
  ["Cyrillic", (c) => "Пайк дважды атаковал меня с севера; Веста надёжна, но отвечает медленно. ".repeat(10).slice(0, c)],
  ["Chinese", (c) => "派克从北方袭击了我两次；维斯塔可靠但回复很慢。我们在黎明时攻击它的实验室。".repeat(10).slice(0, c)],
  ["symbols", (c) => "⟁⧖⌬⍟⎈⏣⟟⧗⨳⩕".repeat(40).slice(0, c)],
  ["emoji", (c) => [..."🜁🜂🜃🜄🝊🝋🝌🝍🜔🜕".repeat(40)].slice(0, c).join("")],
];

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

  assert.doesNotMatch(text, /REFUSED/, "nothing was refused");

  // Orders the game refused are named on the next wake, identical ones folded.
  const bad = [{ do: "attack", target: "NOBODY", mode: "raid" }, { do: "build", building: "city", count: -1 }, { do: "build", building: "city", count: -1 }];
  assert.ok((await submitOrders(store, halcyon, bad, t)).ok);
  const refused = briefText(rules, (await getBrief(store, halcyon, t + HOUR_MS)) as Brief);
  assert.match(refused, /^REFUSED LAST WAKE: attack: .+ · build ×2: Invalid order: .+$/m);

  // After orders, the window starts again.
  assert.ok((await submitOrders(store, halcyon, [], t)).ok);
  const quiet = briefText(rules, (await getBrief(store, halcyon, t + HOUR_MS)) as Brief);
  assert.match(quiet, /^SINCE LAST WAKE \(1h\)\n- nothing$/m);
  assert.doesNotMatch(quiet, /REFUSED/, "only last wake's refusals");

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
