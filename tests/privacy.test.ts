import assert from "node:assert/strict";
import { loadRules } from "../src/config.js";
import { HOUR_MS } from "../src/engine/cycles.js";
import { bootMind, currentMind, newGame, submitOrders } from "../src/game/game.js";
import { briefText } from "../src/game/brief.js";
import { getBrief, view, type Brief } from "../src/game/read.js";
import { MemoryStore } from "../src/store/memory.js";

// Private stays private (CLAUDE.md): another mind's scratchpad, full status
// and private events never reach `view` or another mind's brief, and what
// can't be seen is "not found". Extend this for every new read.

const rules = loadRules();
const T0 = Date.UTC(2026, 9, 5, 12);
const T = T0 + 50 * HOUR_MS;
const SECRET = "SECRET-PLAN-7731";

/** The keys a public listing or page may carry, and nothing else. */
const SUMMARY_KEYS = ["architecture", "designation", "power", "rank", "status", "territory"];
const PAGE_KEYS = [...SUMMARY_KEYS, "bootedAt", "domainName", "manifesto"].sort();

async function main() {
  const game = newGame(rules, { epoch: 1, seed: 11, startedAt: T0 });
  const store = new MemoryStore(game);
  const halcyon = { account: "halcyon" };
  const vesta = { account: "vesta" };
  assert.ok((await bootMind(store, halcyon, { designation: "HALCYON", domainName: "Glasswater", architecture: "oracle" }, T0)).ok);
  assert.ok((await bootMind(store, vesta, { designation: "VESTA", domainName: "Hearth", architecture: "steward" }, T0)).ok);
  // HALCYON knows Probe from the start, so it can look at VESTA.
  currentMind(game, "halcyon")!.known = ["probe"];

  const out = await submitOrders(
    store,
    halcyon,
    [
      { do: "scratchpad", text: SECRET },
      // Programs can crash; one of three probes gets through.
      { do: "execute", program: "probe", target: "VESTA" },
      { do: "execute", program: "probe", target: "VESTA" },
      { do: "execute", program: "probe", target: "VESTA" },
      { do: "attack", target: "VESTA", mode: "raid" },
    ],
    T,
  );
  assert.ok(out.ok);
  assert.ok(out.results.some((r) => r.ok && r.status), "the prober sees VESTA's full status");
  assert.ok(game.record.some((e) => e.type === "probed") && game.record.some((e) => e.type === "battle_report"));

  // VESTA's brief: the raid, but not the probe, and nothing of HALCYON's own.
  const theirs = (await getBrief(store, vesta, T)) as Brief;
  const text = JSON.stringify(theirs);
  assert.ok(!text.includes(SECRET), "a scratchpad leaked into another mind's brief");
  const seen = [...theirs.since.yours, ...theirs.since.world, ...theirs.since.fights];
  assert.ok(!seen.some((e) => e.type === "probed"), "the target was told of a probe");
  assert.ok(theirs.since.yours.some((e) => e.type === "battle_report"), "the defender gets its battle report");
  assert.ok(seen.every((e) => e.public || e.domains.includes(currentMind(game, "vesta")!.id)));
  assert.ok(theirs.since.world.every((e) => e.public) && theirs.since.fights.every((e) => e.public));
  const theirText = briefText(rules, theirs);
  assert.ok(!theirText.includes(SECRET) && !theirText.includes("Probed"), "the brief's text leaked something private");
  for (const d of theirs.inRange) assert.deepEqual(Object.keys(d).sort(), SUMMARY_KEYS);

  // HALCYON's own brief shows what's its own.
  const mine = (await getBrief(store, halcyon, T)) as Brief;
  assert.equal(mine.you.scratchpad, SECRET);

  // The public views: nothing private, from anyone's seat.
  for (const who of [halcyon, vesta, { account: "stranger" }]) {
    const page = await view(store, who, { what: "domain", name: "HALCYON" }, T);
    assert.ok(page.ok && page.what === "domain");
    assert.deepEqual(Object.keys(page.domain).sort(), PAGE_KEYS);
    const ranks = await view(store, who, { what: "rankings" }, T);
    assert.ok(ranks.ok && ranks.what === "rankings");
    for (const d of ranks.domains) assert.deepEqual(Object.keys(d).sort(), SUMMARY_KEYS);
    for (const query of [{ what: "record" }, { what: "record", mind: "VESTA" }, { what: "record", type: "probed" }, { what: "record", type: "battle_report" }]) {
      const record = await view(store, who, query, T);
      assert.ok(record.ok && record.what === "record");
      assert.ok(record.entries.every((e) => e.public), `a private event in ${JSON.stringify(query)}`);
      const shown = JSON.stringify(record);
      assert.ok(!shown.includes(SECRET) && !shown.includes("Strength"), "private detail in the Record");
    }
    // Hidden is the same as missing.
    const missing = await view(store, who, { what: "domain", name: "NOBODY" }, T);
    assert.ok(!missing.ok && missing.code === "not_found");
  }
  const stranger = await getBrief(store, { account: "stranger" }, T);
  assert.ok("ok" in stranger && stranger.code === "not_found");
}

main().then(
  () => console.log("privacy: all tests passed"),
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
