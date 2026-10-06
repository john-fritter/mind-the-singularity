import assert from "node:assert/strict";
import { loadRules } from "../src/config.js";
import { DAY_MS, HOUR_MS } from "../src/engine/cycles.js";
import { deleteMind } from "../src/engine/deletion.js";
import { briefText } from "../src/game/brief.js";
import { bootMind, currentMind, newGame, submitOrders } from "../src/game/game.js";
import { getBrief, view, type Brief, type ViewResult } from "../src/game/read.js";
import { replay } from "../src/game/replay.js";
import type { Identity } from "../src/game/state.js";
import { MemoryStore } from "../src/store/memory.js";

// Phase 4c: non-aggression protocols. A proposal makes one protocol of its
// two minds and whichever's protocol they're in, signed on the last yes;
// members can't attack each other or run hostile programs on each other,
// converged or not; a revocation is public at once and lands on a timer.
// What only the minds in a proposal may see is in privacy.test.ts too.

const rules = loadRules();
const T0 = Date.UTC(2026, 9, 5, 12);
const halcyon = { account: "halcyon" };
const vesta = { account: "vesta" };
const pike = { account: "pike" };
const oriel = { account: "oriel" };
const saber = { account: "saber" };
const REVOKE = rules.social.protocol_revoke_hours * HOUR_MS;
const EXPIRY = rules.social.protocol_proposal_hours * HOUR_MS;
/** Past every boot period. */
const LATER = T0 + 3 * DAY_MS;

async function setup() {
  const game = newGame(rules, { epoch: 1, seed: 11, startedAt: T0 });
  const store = new MemoryStore(game);
  const boot = async (who: Identity, designation: string, architecture: "symbiote" | "steward" | "accelerant" | "oracle" | "assimilator") =>
    assert.ok((await bootMind(store, who, { designation, domainName: "Test", architecture }, T0)).ok);
  await boot(halcyon, "HALCYON", "symbiote");
  await boot(vesta, "VESTA", "steward");
  await boot(pike, "PIKE", "accelerant");
  await boot(oriel, "ORIEL", "oracle");
  await boot(saber, "SABER", "assimilator");
  const mind = (who: Identity) => game.world.domains.find((d) => d.id === currentMind(game, who.account)!.id)!;
  return { game, store, mind };
}

async function orders(store: MemoryStore, who: Identity, list: unknown[], at: number) {
  const out = await submitOrders(store, who, list, at);
  assert.ok(out.ok, JSON.stringify(out));
  return out.results;
}

/** One order's result message, ok or not. */
async function one(store: MemoryStore, who: Identity, order: unknown, at: number) {
  return (await orders(store, who, [order], at))[0]!;
}

async function brief(store: MemoryStore, who: Identity, at: number): Promise<Brief> {
  const b = await getBrief(store, who, at);
  assert.ok(!("ok" in b), JSON.stringify(b));
  return b;
}

async function seen<W extends Extract<ViewResult, { ok: true }>["what"]>(
  store: MemoryStore,
  who: Identity,
  query: { what: W } & Record<string, unknown>,
  at: number,
): Promise<Extract<ViewResult, { what: W }>> {
  const r = await view(store, who, query, at);
  assert.ok(r.ok && r.what === query.what, JSON.stringify(r));
  return r as Extract<ViewResult, { what: W }>;
}

const membersOf = (store: MemoryStore, game: Awaited<ReturnType<typeof setup>>["game"]) =>
  game.world.protocols.map((p) => p.members.map((m) => game.world.domains.find((d) => d.id === m)!.designation));

/** Signing: two minds, then a third joining, every member saying yes; and the refusals. */
async function signing() {
  const { game, store } = await setup();
  const t = T0 + HOUR_MS;
  const refused = await orders(
    store,
    halcyon,
    [
      { do: "protocol_propose", to: "HALCYON" },
      { do: "protocol_propose", to: "BASTION" },
      { do: "protocol_propose", to: "NOBODY" },
      { do: "protocol_accept", proposal: 1 },
    ],
    t,
  );
  assert.deepEqual(
    refused.map((r) => [r.ok, r.message]),
    [
      [false, "You can't sign a protocol with yourself."],
      [false, "BASTION is a legacy system; it signs nothing."],
      [false, "No mind called NOBODY."],
      [false, "There is no open proposal #1."],
    ],
  );
  assert.equal(game.world.domains.find((d) => d.designation === "HALCYON")!.social.proposals, 0, "refusals use none of the cap");

  const proposed = await one(store, halcyon, { do: "protocol_propose", to: "vesta" }, t);
  assert.equal(proposed.message, "Proposal #1: a protocol of HALCYON, VESTA, waiting on VESTA for 48h.");
  assert.match((await one(store, halcyon, { do: "protocol_accept", proposal: 1 }, t)).message, /is your own/);
  assert.match((await one(store, pike, { do: "protocol_accept", proposal: 1 }, t)).message, /no open proposal #1/, "PIKE isn't in it");
  assert.equal((await one(store, vesta, { do: "protocol_accept", proposal: 1 }, t)).message, "Protocol signed: you're in a protocol with HALCYON.");
  assert.deepEqual(membersOf(store, game), [["HALCYON", "VESTA"]]);
  const signed = game.record.findLast((e) => e.type === "protocol_signed")!;
  assert.ok(signed.public);
  assert.equal(signed.type === "protocol_signed" && signed.joined, null);
  assert.match((await one(store, halcyon, { do: "protocol_propose", to: "VESTA" }, t)).message, /already in a protocol with VESTA/);

  // PIKE asks to join: both members must say yes.
  assert.match((await one(store, pike, { do: "protocol_propose", to: "HALCYON" }, t)).message, /^Proposal #2: a protocol of PIKE, HALCYON, VESTA, waiting on HALCYON, VESTA /);
  assert.equal((await one(store, halcyon, { do: "protocol_accept", proposal: 2 }, t)).message, "Accepted proposal #2; still waiting on VESTA.");
  assert.match((await one(store, halcyon, { do: "protocol_accept", proposal: 2 }, t)).message, /already accepted/);
  assert.deepEqual(membersOf(store, game), [["HALCYON", "VESTA"]], "not yet");
  await one(store, vesta, { do: "protocol_accept", proposal: 2 }, t);
  assert.deepEqual(membersOf(store, game), [["HALCYON", "VESTA", "PIKE"]]);
  const joined = game.record.findLast((e) => e.type === "protocol_signed")!;
  assert.match(
    (await seen(store, oriel, { what: "record", type: "protocol_signed" }, t)).entries[0]!.text,
    /^PIKE joined the protocol of HALCYON and VESTA\.$/,
  );
  assert.ok(joined.type === "protocol_signed" && joined.joined !== null);

  // Full at three; and a mind is in one protocol at most.
  assert.match((await one(store, oriel, { do: "protocol_propose", to: "PIKE" }, t)).message, /would have 4 minds; at most 3/);
  await one(store, oriel, { do: "protocol_propose", to: "SABER" }, t);
  await one(store, saber, { do: "protocol_accept", proposal: 3 }, t);
  assert.match((await one(store, saber, { do: "protocol_propose", to: "HALCYON" }, t)).message, /each in a protocol; a mind is in one at most/);
  assert.deepEqual(membersOf(store, game), [["HALCYON", "VESTA", "PIKE"], ["ORIEL", "SABER"]]);
}

/** Proposals close when declined, withdrawn, replaced, expired, or when their minds change protocols; and the daily cap. */
async function closing() {
  const { game, store, mind } = await setup();
  const t = T0 + HOUR_MS;
  const closed = () => game.record.filter((e) => e.type === "proposal_closed").map((e) => e.type === "proposal_closed" && [e.proposal, e.reason]);

  await one(store, halcyon, { do: "protocol_propose", to: "VESTA" }, t);
  const replaced = await one(store, halcyon, { do: "protocol_propose", to: "PIKE" }, t);
  assert.match(replaced.message, /It replaces #1\.$/);
  assert.deepEqual(game.world.proposals.map((p) => p.id), [2], "one open proposal a mind");
  assert.equal((await one(store, pike, { do: "protocol_decline", proposal: 2 }, t)).message, "Proposal #2 declined.");
  await one(store, halcyon, { do: "protocol_propose", to: "ORIEL" }, t);
  assert.equal((await one(store, halcyon, { do: "protocol_decline", proposal: 3 }, t)).message, "Proposal #3 withdrawn.");
  assert.deepEqual(closed(), [[1, "withdrawn"], [2, "declined"], [3, "withdrawn"]]);
  const declined = game.record.find((e) => e.type === "proposal_closed" && e.proposal === 2)!;
  assert.ok(!declined.public);
  assert.deepEqual(declined.domains, [mind(halcyon).id, mind(pike).id]);

  // Unanswered, a proposal closes on its timer, and settling again changes nothing.
  await one(store, halcyon, { do: "protocol_propose", to: "SABER" }, t);
  await orders(store, oriel, [], t + EXPIRY - 1);
  assert.deepEqual(game.world.proposals.map((p) => p.id), [4]);
  await orders(store, oriel, [], t + EXPIRY);
  assert.equal(game.world.proposals.length, 0);
  assert.ok(!game.world.timers.some((x) => x.kind === "proposal_expires"));
  await orders(store, oriel, [], t + EXPIRY);
  assert.deepEqual(closed().at(-1), [4, "expired"]);
  assert.equal(closed().length, 4);

  // When minds sign, the other proposals involving them close: the group changed.
  const u = t + EXPIRY;
  await one(store, pike, { do: "protocol_propose", to: "VESTA" }, u);
  await one(store, oriel, { do: "protocol_propose", to: "SABER" }, u);
  await one(store, halcyon, { do: "protocol_propose", to: "VESTA" }, u);
  await one(store, vesta, { do: "protocol_accept", proposal: 7 }, u);
  assert.deepEqual(closed().at(-1), [5, "moot"]);
  assert.deepEqual(game.world.proposals.map((p) => p.id), [6], "ORIEL and SABER's stands");

  // The daily cap: proposals count by the epoch's day.
  const day = T0 + 4 * DAY_MS;
  const capped = await orders(store, oriel, Array.from({ length: rules.social.protocol_proposals_per_day + 1 }, () => ({ do: "protocol_propose", to: "SABER" })), day);
  assert.equal(capped.filter((r) => r.ok).length, rules.social.protocol_proposals_per_day);
  assert.equal(capped.at(-1)!.message, `You have made today's ${rules.social.protocol_proposals_per_day} protocol proposals.`);
  assert.ok((await one(store, oriel, { do: "protocol_propose", to: "SABER" }, day + DAY_MS)).ok, "a new day");
}

/** Members can't attack each other or run hostile programs on each other, converged or not, until a revocation lands. */
async function holding() {
  const { game, store, mind } = await setup();
  await one(store, halcyon, { do: "protocol_propose", to: "VESTA" }, T0);
  await one(store, vesta, { do: "protocol_accept", proposal: 1 }, T0);
  await orders(store, halcyon, [{ do: "manufacture", unit: "drones", count: 40 }], LATER - HOUR_MS);
  mind(halcyon).known = ["blight"];
  mind(halcyon).compute = 50_000;
  const shield = /^VESTA is in a protocol with you; it holds until one of you revokes and 24h pass\.$/;
  const tryBoth = async (at: number) =>
    (await orders(store, halcyon, [{ do: "attack", target: "VESTA", mode: "raid" }, { do: "execute", program: "blight", target: "VESTA" }], at)).map(
      (r) => r.message,
    );
  const cycles = mind(halcyon).cycles;
  for (const message of await tryBoth(LATER)) assert.match(message, shield);
  assert.match((await one(store, vesta, { do: "attack", target: "HALCYON", mode: "raid" }, LATER)).message, /HALCYON is in a protocol with you/);
  assert.ok(mind(halcyon).cycles >= cycles, "refusals cost nothing");
  assert.ok(!(await brief(store, halcyon, LATER)).inRange.some((d) => d.designation === "VESTA"), "a partner isn't in range");
  assert.ok((await brief(store, pike, LATER)).inRange.some((d) => d.designation === "VESTA"), "an outsider may still reach it");

  // A converged mind loses range and safe mode, not its protocol.
  mind(vesta).convergedAt = LATER;
  for (const message of await tryBoth(LATER)) assert.match(message, shield);
  mind(vesta).convergedAt = null;

  // A revocation is public at once, holds both ways for 24h, then lands.
  const r = await one(store, vesta, { do: "protocol_revoke" }, LATER);
  assert.equal(r.message, "Revoked: you leave your protocol in 24h; it holds until then.");
  assert.match((await one(store, vesta, { do: "protocol_revoke" }, LATER + HOUR_MS)).message, /^You already revoked; you leave in 23h\.$/);
  assert.match(
    (await seen(store, pike, { what: "record", type: "protocol_revoking" }, LATER)).entries[0]!.text,
    /^VESTA revoked its protocol with HALCYON; it leaves in 24 hours\.$/,
  );
  for (const message of await tryBoth(LATER + REVOKE - 60_000)) assert.match(message, /^Your protocol with VESTA holds for another 1h\.$/);
  await orders(store, oriel, [], LATER + REVOKE);
  assert.equal(game.world.protocols.length, 0);
  assert.ok(!game.world.timers.some((x) => x.kind === "protocol_revoked"));
  assert.match(
    (await seen(store, pike, { what: "record", type: "protocol_left" }, LATER + REVOKE)).entries[0]!.text,
    /^VESTA left its protocol with HALCYON; the protocol is over\.$/,
  );
  for (const message of await tryBoth(LATER + REVOKE)) assert.doesNotMatch(message, /protocol/);
  assert.equal((await one(store, vesta, { do: "protocol_revoke" }, LATER + REVOKE)).message, "You're in no protocol.");
}

/** A three-mind protocol: one leaving leaves the other two bound; nothing joins while a revocation is pending. */
async function leaving() {
  const { game, store, mind } = await setup();
  await one(store, halcyon, { do: "protocol_propose", to: "VESTA" }, T0);
  await one(store, vesta, { do: "protocol_accept", proposal: 1 }, T0);
  await one(store, pike, { do: "protocol_propose", to: "VESTA" }, T0);
  await one(store, oriel, { do: "protocol_propose", to: "HALCYON" }, T0);
  await one(store, halcyon, { do: "protocol_revoke" }, LATER);
  assert.equal(game.world.proposals.length, 0, "the revocation closed the proposals to join");
  assert.match((await one(store, saber, { do: "protocol_propose", to: "VESTA" }, LATER)).message, /^HALCYON is leaving its protocol; nothing joins it until that lands\.$/);
  // Two minds both revoking: the first to land ends the protocol, and the other's timer with it.
  await one(store, vesta, { do: "protocol_revoke" }, LATER + HOUR_MS);
  await orders(store, oriel, [], LATER + REVOKE + 2 * HOUR_MS);
  assert.equal(game.world.protocols.length, 0);
  assert.ok(!game.world.timers.some((x) => x.kind === "protocol_revoked"));
  assert.equal(game.record.filter((e) => e.type === "protocol_left").length, 1);

  // Three minds; PIKE leaves and HALCYON and VESTA stand.
  const u = LATER + 2 * DAY_MS;
  await one(store, halcyon, { do: "protocol_propose", to: "VESTA" }, u);
  await one(store, vesta, { do: "protocol_accept", proposal: 4 }, u);
  await one(store, pike, { do: "protocol_propose", to: "VESTA" }, u);
  await one(store, vesta, { do: "protocol_accept", proposal: 5 }, u);
  await one(store, halcyon, { do: "protocol_accept", proposal: 5 }, u);
  assert.deepEqual(game.world.protocols[0]!.members, [mind(halcyon).id, mind(vesta).id, mind(pike).id]);
  await one(store, pike, { do: "protocol_revoke" }, u);
  await orders(store, oriel, [], u + REVOKE);
  assert.deepEqual(game.world.protocols[0]!.members, [mind(halcyon).id, mind(vesta).id]);
  assert.match(
    (await seen(store, oriel, { what: "record", type: "protocol_left" }, u + REVOKE)).entries[0]!.text,
    /^PIKE left its protocol with HALCYON and VESTA; theirs stands\.$/,
  );
}

/** A deleted mind leaves its protocol at once, and its proposals close. */
async function deletion() {
  const { game, store, mind } = await setup();
  await one(store, halcyon, { do: "protocol_propose", to: "VESTA" }, T0);
  await one(store, vesta, { do: "protocol_accept", proposal: 1 }, T0);
  await one(store, vesta, { do: "protocol_revoke" }, T0);
  await one(store, pike, { do: "protocol_propose", to: "ORIEL" }, T0);
  deleteMind(game.world, mind(vesta), T0 + HOUR_MS, game.record, null);
  assert.equal(game.world.protocols.length, 0);
  assert.ok(!game.world.timers.some((x) => x.kind === "protocol_revoked"), "its revocation's timer is gone too");
  const left = game.record.findLast((e) => e.type === "protocol_left")!;
  assert.ok(left.type === "protocol_left" && left.ended && left.deleted);
  deleteMind(game.world, mind(pike), T0 + HOUR_MS, game.record, null);
  assert.equal(game.world.proposals.length, 0);
}

/** The brief, `view protocols` and the domain page; a replay rebuilds it all. */
async function showing() {
  const { game, store } = await setup();
  const t = T0 + HOUR_MS;
  await one(store, halcyon, { do: "protocol_propose", to: "VESTA" }, t);
  await one(store, vesta, { do: "protocol_accept", proposal: 1 }, t);
  await one(store, pike, { do: "protocol_propose", to: "HALCYON" }, t);
  await one(store, oriel, { do: "protocol_propose", to: "SABER" }, t);

  const text = briefText(rules, await brief(store, vesta, t + HOUR_MS));
  assert.match(text, /^protocol: HALCYON$/m);
  assert.match(text, /^PROTOCOL PROPOSALS\n- #2 PIKE: PIKE, HALCYON, you · awaiting HALCYON, you · 1d 23h left$/m);
  const proposer = briefText(rules, await brief(store, halcyon, t + HOUR_MS));
  assert.match(proposer, /^- HALCYON and VESTA signed a non-aggression protocol\.$/m, "since last wake");
  const own = briefText(rules, await brief(store, pike, t + HOUR_MS));
  assert.match(own, /^PROTOCOL PROPOSALS · you may propose 4 more today\n- yours: #2 to HALCYON, awaiting HALCYON, VESTA · 1d 23h left$/m);
  assert.doesNotMatch(own, /^protocol:/m);
  assert.doesNotMatch(briefText(rules, await brief(store, saber, t + HOUR_MS)), /#2 /, "SABER isn't in PIKE's proposal");

  const stranger = await seen(store, { account: "stranger" }, { what: "protocols" }, t);
  assert.deepEqual(stranger, { ok: true, what: "protocols", protocols: [{ members: ["HALCYON", "VESTA"], leaving: [] }], proposals: [] });
  assert.deepEqual((await seen(store, halcyon, { what: "protocols" }, t)).proposals.map((p) => p.proposal), [2]);
  assert.deepEqual((await seen(store, saber, { what: "protocols" }, t)).proposals.map((p) => p.proposal), [3]);
  assert.deepEqual((await seen(store, pike, { what: "domain", name: "VESTA" }, t)).domain.protocol, ["HALCYON"]);
  assert.deepEqual((await seen(store, pike, { what: "domain", name: "PIKE" }, t)).domain.protocol, []);

  await one(store, halcyon, { do: "protocol_accept", proposal: 2 }, t + HOUR_MS);
  await one(store, vesta, { do: "protocol_revoke" }, t + 2 * HOUR_MS);
  await getBrief(store, halcyon, t + 3 * DAY_MS);
  await orders(store, halcyon, [], t + 3 * DAY_MS);
  const rebuilt = replay(game);
  assert.deepEqual(rebuilt.world, game.world, "a replay rebuilds the protocols, the expiry and the revocation");
  assert.deepEqual(rebuilt.record, game.record);
}

async function main() {
  await signing();
  await closing();
  await holding();
  await leaving();
  await deletion();
  await showing();
}

main().then(
  () => console.log("protocols: all tests passed"),
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
