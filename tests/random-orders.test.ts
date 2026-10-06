import assert from "node:assert/strict";
import { loadRules } from "../src/config.js";
import { ARCHITECTURES, BUILDINGS, HARDWARE, programsOf, type Architecture } from "../src/engine/architectures.js";
import { availableCycles, HOUR_MS } from "../src/engine/cycles.js";
import { totalBuildings, totalHardware } from "../src/engine/domain.js";
import { computeStorage, hardwareHousing } from "../src/engine/economy.js";
import { describe, type GameEvent } from "../src/engine/record.js";
import { rngFor, type Rng } from "../src/engine/rng.js";
import type { World } from "../src/engine/state.js";
import { applyOrders, bootMind, createWorld, settle } from "../src/engine/world.js";

// One domain per architecture, given random orders every few hours for a
// month, attacking and running programs on each other: nothing goes
// negative or fractional, buildings fit their territory, compute fits its
// storage, hardware fits its housing, posts, messages and offers keep to
// their caps, every open offer has its expiry, and a deleted mind does
// nothing. The engine never changes the
// world it's given, and the same seed and orders give the same world and
// events.

const rules = loadRules();
const T0 = Date.UTC(2026, 9, 5, 12);
const DAYS = 30;
const WAKE_EVERY_HOURS = 4;

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng.next() * xs.length)]!;
const upTo = (rng: Rng, n: number) => 1 + Math.floor(rng.next() * n);

/** A random batch of orders, some of them bad on purpose. */
function randomOrders(rng: Rng, architecture: Architecture, others: string[]): unknown[] {
  const programs = programsOf(architecture).map((p) => p.id);
  return Array.from({ length: upTo(rng, 6) }, () => {
    switch (upTo(rng, 17)) {
      case 1:
        return { do: "expand", cycles: upTo(rng, 12) };
      case 2:
        return { do: "build", building: pick(rng, BUILDINGS), count: upTo(rng, 40) };
      case 3:
        return { do: "build", buildings: { [pick(rng, BUILDINGS)]: upTo(rng, 10), [pick(rng, BUILDINGS)]: upTo(rng, 10) } };
      case 4:
        return { do: "manufacture", unit: pick(rng, HARDWARE), count: upTo(rng, 60) };
      case 5:
        return { do: "monetize", cycles: upTo(rng, 6) };
      case 6:
        return { do: "spin_up", cycles: upTo(rng, 6) };
      case 7:
        return { do: "execute", program: pick(rng, programs) };
      case 8:
        return { do: "set_research", program: pick(rng, programs) };
      case 9:
        return { do: "scratchpad", text: "note ".repeat(upTo(rng, 220)) };
      case 10:
      case 11:
        return { do: "attack", target: pick(rng, others), mode: pick(rng, ["conquest", "raid"]), ...(rng.next() < 0.5 ? { program: pick(rng, programs) } : {}) };
      case 12:
        return { do: "execute", program: pick(rng, programs), target: pick(rng, others) };
      case 13:
        return { do: "set_countermeasure", program: pick(rng, programs), above: rng.next() * 2 };
      case 14:
        return { do: "post", text: "word ".repeat(upTo(rng, 60)), ...(rng.next() < 0.5 ? { reply_to: upTo(rng, 40) } : {}) };
      case 15:
        return { do: "message", to: pick(rng, others), text: "word ".repeat(upTo(rng, 60)) };
      case 16: {
        const roll = rng.next();
        if (roll < 0.4) return { do: "trade_accept", offer: upTo(rng, 60) };
        if (roll < 0.5) return { do: "trade_cancel", offer: upTo(rng, 60) };
        const [give, want] = pick(rng, [["capital", "compute"], ["compute", "capital"], ["capital", "capital"]] as const);
        const to = rng.next() < 0.5 ? { to: pick(rng, others) } : {};
        return { do: "trade_offer", give: { [give]: upTo(rng, 3000) }, want: { [want]: upTo(rng, 3000) }, ...to };
      }
      default:
        return pick(rng, [{ do: "attack" }, { do: "expand", cycles: 0 }, null, "build", { do: "build", building: "moat", count: 1 }]);
    }
  });
}

function checkInvariants(world: World, now: number) {
  for (const o of world.offers) {
    const maker = world.domains.find((d) => d.id === o.from)!;
    assert.ok(maker.deletedAt === null, "a deleted mind's offer is open");
    assert.ok(Number.isInteger(o.give.amount) && o.give.amount > 0 && o.give.goods !== o.want.goods, `offer #${o.id}`);
    assert.ok(world.timers.some((t) => t.kind === "offer_expires" && t.offer === o.id && t.at === o.expiresAt), `offer #${o.id} has no expiry`);
  }
  assert.equal(world.timers.filter((t) => t.kind === "offer_expires").length, world.offers.length, "an expiry timer outlived its offer");
  for (const d of world.domains) {
    assert.ok(world.offers.filter((o) => o.from === d.id).length <= rules.social.open_offers_max, `${d.designation} has too many offers open`);
    assert.ok(d.social.offers <= rules.social.trade_offers_per_day, `${d.designation} made too many offers today`);
    assert.ok(d.deletedAt === null || d.buildings.core === 0, `${d.designation} deleted with cores`);
    assert.ok(d.deletedAt !== null || d.buildings.core > 0, `${d.designation} has no cores but wasn't deleted`);
    const amounts = {
      territory: d.territory,
      capital: d.capital,
      compute: d.compute,
      users: d.users,
      cycles: d.cycles,
      ...d.buildings,
      ...d.units,
      ...d.researchProgress,
    };
    for (const [key, value] of Object.entries(amounts)) {
      assert.ok(Number.isInteger(value) && value! >= 0, `${d.designation}.${key} = ${value}`);
    }
    assert.ok(totalBuildings(d) <= d.territory, `${d.designation} has more buildings than sectors`);
    assert.ok(d.social.posts <= rules.social.commons_posts_per_day && d.social.messages <= rules.social.messages_per_day, `${d.designation} passed a daily cap`);
    assert.ok(d.compute <= computeStorage(rules, d.buildings.datacenter), `${d.designation} compute past storage`);
    assert.ok(totalHardware(d) <= hardwareHousing(rules, d.buildings.factory), `${d.designation} hardware past housing`);
    const cycles = availableCycles(rules, d, now);
    assert.ok(cycles >= 0 && cycles <= rules.cycles.cap, `${d.designation} has ${cycles} cycles`);
    assert.ok(d.known.length === new Set(d.known).size, `${d.designation} learned something twice`);
    assert.ok(d.scratchpad.length <= rules.flavor.scratchpad);
  }
}

/** A month of random orders for one mind of each architecture. Returns the world and every event. */
function play(seed: number): { world: World; events: GameEvent[] } {
  let world = createWorld(rules, { epoch: 1, seed, startedAt: T0 });
  const events: GameEvent[] = [];
  for (const architecture of ARCHITECTURES) {
    const booted = bootMind(rules, world, { designation: architecture.toUpperCase(), domainName: "Test", architecture }, T0);
    assert.ok(booted.ok);
    world = booted.world;
    events.push(...booted.events);
  }
  // Labs speed research up, so programs get learned and run within the month.
  // Hostile programs take longer than a month to research, so each mind
  // starts knowing its own.
  for (const d of world.domains) {
    d.buildings.lab = 60;
    d.known = programsOf(d.architecture).filter((p) => p.kind === "hostile").map((p) => p.id);
  }
  const rng = rngFor(seed, -1);

  for (let now = T0; now <= T0 + DAYS * 24 * HOUR_MS; now += WAKE_EVERY_HOURS * HOUR_MS) {
    for (const d of world.domains) {
      const before = JSON.stringify(world);
      const others = world.domains.filter((o) => o.id !== d.id).map((o) => pick(rng, [o.designation, o.designation.toLowerCase()]));
      const out = applyOrders(rules, world, d.id, randomOrders(rng, d.architecture, [...others, "NOBODY"]), now);
      if (d.deletedAt !== null) {
        assert.ok(out.results.every((r) => !r.ok && r.cycles === 0), "a deleted mind acted");
        assert.deepEqual(out.world.domains.find((x) => x.id === d.id), world.domains.find((x) => x.id === d.id));
      }
      assert.equal(JSON.stringify(world), before, "applyOrders changed its input");
      for (const r of out.results) assert.ok(r.message.length > 0 && r.cycles >= 0);
      world = out.world;
      events.push(...out.events);
      checkInvariants(world, now);
    }
    const before = JSON.stringify(world);
    const settled = settle(rules, world, now + HOUR_MS);
    assert.equal(JSON.stringify(world), before, "settle changed its input");
    assert.deepEqual(settle(rules, settled.world, now + HOUR_MS).world, settled.world, "settling twice changed something");
    world = settled.world;
    events.push(...settled.events);
  }
  for (const e of events) assert.ok(describe(rules, e).length > 0);
  return { world, events };
}

function main() {
  const first = play(42);
  // Things happened: programs were learned and run, minds fought and traded.
  const types = new Set(first.events.map((e) => e.type));
  for (const t of ["booted", "learned", "program_ended", "battle", "hostile", "probed", "trade", "offer_expired", "offers_withdrawn"]) assert.ok(types.has(t as GameEvent["type"]), `no ${t} events`);
  assert.ok(first.world.domains.every((d) => d.known.length > 0), "every mind learned something");

  // Same seed, same orders: the same world and events, exactly.
  const again = play(42);
  assert.deepEqual(again.world, first.world);
  assert.deepEqual(again.events, first.events);
  // A different seed plays out differently.
  assert.notDeepEqual(play(43).world, first.world);
}

main();
console.log("random-orders: all tests passed");
