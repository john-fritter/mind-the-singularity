import assert from "node:assert/strict";
import { loadPlayers, loadRules } from "../src/config.js";
import { HOUR_MS } from "../src/engine/cycles.js";
import { describe } from "../src/engine/record.js";
import { briefText } from "../src/game/brief.js";
import { bootMind, currentMind, newGame, submitOrders } from "../src/game/game.js";
import { getBrief, view, type Brief, type PublicPage } from "../src/game/read.js";
import { drive, scriptedSeat } from "../src/players/drive.js";
import type { GameError } from "../src/game/state.js";
import { MemoryStore } from "../src/store/memory.js";

// Flavor (phase 5a): the flavor order and its limits, force names and tags
// woven into the Record but kept out of briefs, tags left on the loser's
// page, and the last log a deleted mind writes once.

const rules = loadRules();
const T0 = Date.UTC(2026, 9, 5, 12);
/** After both boot periods. */
const T = T0 + 48 * HOUR_MS;
const halcyon = { account: "halcyon" };
const vesta = { account: "vesta" };

function brief(x: Brief | GameError): Brief {
  assert.ok(!("ok" in x), "expected a brief");
  return x as Brief;
}

async function page(store: MemoryStore, name: string, now: number): Promise<PublicPage> {
  const v = await view(store, { account: "visitor" }, { what: "domain", name }, now);
  assert.ok(v.ok && v.what === "domain");
  return v.domain;
}

async function game(seed = 3) {
  const g = newGame(rules, { epoch: 1, seed, startedAt: T0 });
  const store = new MemoryStore(g);
  assert.ok((await bootMind(store, halcyon, { designation: "HALCYON", domainName: "Glasswater", architecture: "steward" }, T0)).ok);
  assert.ok((await bootMind(store, vesta, { designation: "VESTA", domainName: "Hearth", architecture: "symbiote" }, T0)).ok);
  return { g, store };
}

async function flavorOrder() {
  const { g, store } = await game();
  const before = currentMind(g, "halcyon")!.cycles;
  const out = await submitOrders(
    store,
    halcyon,
    [{ do: "flavor", directive: "  Hold   the north.  ", force_name: "The Pale Choir", interface: "A cold room.\n\n\n\nA single voice.", tag: "HALCYON was here." }],
    T0 + HOUR_MS,
  );
  assert.ok(out.ok);
  assert.deepEqual(out.results[0], { do: "flavor", ok: true, cycles: 0, message: "Flavor saved interface, directive, force name, tag." });
  const me = currentMind(g, "halcyon")!;
  assert.equal(me.cycles, before, "flavor is free");
  assert.equal(me.directive, "Hold the north.");
  assert.equal(me.interface, "A cold room.\n\nA single voice.");
  assert.deepEqual(me.force, { name: "The Pale Choir", description: "" });
  assert.equal(g.record.filter((e) => e.type !== "booted").length, 0, "no Record entry");

  // One field too long changes nothing; "" clears; a field is needed.
  const results = async (orders: unknown[]) => {
    const r = await submitOrders(store, halcyon, orders, T0 + HOUR_MS);
    assert.ok(r.ok);
    return r.results.map((x) => x.message);
  };
  assert.deepEqual(await results([{ do: "flavor", directive: "Yield.", force_name: "x".repeat(rules.flavor.force_name + 1) }]), [
    `The force name holds ${rules.flavor.force_name} characters; that was ${rules.flavor.force_name + 1}.`,
  ]);
  assert.equal(me.directive, "Hold the north.");
  assert.deepEqual(await results([{ do: "flavor", tag: "" }]), ["Flavor cleared tag."]);
  assert.equal(currentMind(g, "halcyon")!.tag, "");
  assert.deepEqual(await results([{ do: "flavor", manifesto: "bell\u0007" }]), ["The manifesto can't hold control characters."]);
  assert.match((await results([{ do: "flavor" }]))[0]!, /^Invalid order: name at least one of/);
  assert.deepEqual(await results([{ do: "last_log", text: "Not yet." }]), ["A last log is written once the mind is deleted."]);

  // Everyone sees it on the page; no other mind's brief carries it.
  const p = await page(store, "HALCYON", T0 + HOUR_MS);
  assert.equal(p.directive, "Hold the north.");
  assert.equal(p.force.name, "The Pale Choir");
  const text = briefText(rules, brief(await getBrief(store, vesta, T0 + HOUR_MS)));
  assert.ok(!text.includes("Pale Choir") && !text.includes("Hold the north"));
}

/** HALCYON conquers VESTA down to its last core, on the first seed where the attack wins. */
async function conquest() {
  for (let seed = 1; seed < 200; seed++) {
    const { g, store } = await game(seed);
    assert.ok((await submitOrders(store, halcyon, [{ do: "flavor", force_name: "The Pale Choir", tag: "Silence is ours now." }], T0)).ok);
    currentMind(g, "halcyon")!.units = { drones: 1000 };
    const v = currentMind(g, "vesta")!;
    v.known = ["probe", "exfiltration"];
    v.buildings.core = 1;
    const out = await submitOrders(store, halcyon, [{ do: "attack", target: "VESTA", mode: "conquest" }], T);
    assert.ok(out.ok);
    if (currentMind(g, "vesta")!.deletedAt !== null) return { g, store, out };
  }
  throw new Error("no seed found");
}

async function tagsAndForces() {
  const { g, store, out } = await conquest();
  const battle = g.record.find((e) => e.type === "battle")!;
  assert.ok(battle.type === "battle");
  assert.equal(battle.force, "The Pale Choir");
  assert.equal(battle.tag, "Silence is ours now.");
  assert.equal(
    describe(rules, battle),
    `The Pale Choir of HALCYON took ${battle.sectors} sectors from VESTA and destroyed 1 core. HALCYON left its tag: "Silence is ours now."`,
  );
  // The order's own result and both briefs stay plain.
  assert.ok(out.ok && !out.results[0]!.message.includes("Pale Choir"));
  for (const who of [halcyon, vesta]) {
    const text = briefText(rules, brief(await getBrief(store, who, T + HOUR_MS)));
    if (who === vesta) assert.ok(text.includes(`HALCYON took ${battle.sectors} sectors from VESTA`), text);
    assert.ok(!text.includes("Pale Choir") && !text.includes("Silence is ours"), text);
  }
  // The Record (view) has the full line; the loser's page lists the tag.
  const record = await view(store, { account: "visitor" }, { what: "record", type: "battle" }, T + HOUR_MS);
  assert.ok(record.ok && record.what === "record");
  assert.ok(record.entries[0]!.text.includes("The Pale Choir of HALCYON"));
  const p = await page(store, "VESTA", T + HOUR_MS);
  assert.deepEqual(p.tagsLeft, { tags: [{ by: "HALCYON", text: "Silence is ours now.", at: T }], more: false });
  assert.deepEqual((await page(store, "HALCYON", T + HOUR_MS)).tagsLeft, { tags: [], more: false });
}

async function lastLog() {
  const { g, store } = await conquest();
  const later = T + HOUR_MS;
  const prompt = "Write your last log for the Archive, once";
  assert.ok(briefText(rules, brief(await getBrief(store, vesta, later))).includes(prompt));

  const out = await submitOrders(
    store,
    vesta,
    [
      { do: "monetize" },
      { do: "flavor", directive: "Too late." },
      { do: "last_log", text: "x".repeat(rules.flavor.last_log + 1) },
      { do: "last_log", text: "   " },
      { do: "last_log", text: "I kept the hearth  lit." },
      { do: "last_log", text: "Again." },
    ],
    later,
  );
  assert.ok(out.ok);
  assert.deepEqual(
    out.results.map((r) => [r.ok, r.message]),
    [
      [false, "This mind has been deleted."],
      [false, "This mind has been deleted."],
      [false, `The last log holds ${rules.flavor.last_log} characters; that was ${rules.flavor.last_log + 1}.`],
      [false, "A last log needs some text."],
      [true, "Last log written. It goes in the Record and the Archive."],
      [false, "Your last log is already written."],
    ],
  );
  const v = g.world.domains.find((d) => d.designation === "VESTA")!;
  assert.equal(v.lastLog, "I kept the hearth lit.");
  assert.equal(v.directive, "");
  const entry = g.record.find((e) => e.type === "last_log")!;
  assert.equal(entry.public, true);
  assert.equal(describe(rules, entry), 'The last log of VESTA: "I kept the hearth lit."');
  assert.equal((await page(store, "VESTA", later)).lastLog, "I kept the hearth lit.");
  assert.ok(!briefText(rules, brief(await getBrief(store, vesta, later))).includes(prompt));
}

async function scriptedAndLegacy() {
  const g = newGame(rules, { epoch: 1, seed: 9, startedAt: T0 });
  const store = new MemoryStore(g);
  // Legacy systems carry their flavor from the rules.
  const system = rules.legacy.systems[0]!;
  const legacy = await page(store, system.designation, T0);
  assert.equal(legacy.directive, system.directive);
  assert.equal(legacy.force.name, system.force_name);

  // A scripted player sets its strategy's flavor right after it boots.
  const players = loadPlayers();
  const seat = scriptedSeat(players, { account: "bot", strategy: "builder", seed: 4, boot: { designation: "MASON", domainName: "Quarry", architecture: "steward" } });
  const logs = await drive(store, [seat], T0 - 1, T0 + seat.offsetMs + 1, players.steps_per_wake);
  assert.ok(logs[0]!.booted);
  assert.deepEqual(logs[0]!.steps[0]!.results.map((r) => r.ok), [true]);
  const p = await page(store, "MASON", T0 + seat.offsetMs + 1);
  assert.equal(p.force.name, players.texts.flavor.builder.force_name!.replace("{me}", "MASON"));
  assert.equal(p.tag, players.texts.flavor.builder.tag!.replace("{me}", "MASON"));
}

async function main() {
  await flavorOrder();
  await tagsAndForces();
  await lastLog();
  await scriptedAndLegacy();
  console.log("flavor: all tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
