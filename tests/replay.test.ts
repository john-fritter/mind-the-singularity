import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRules } from "../src/config.js";
import { ARCHITECTURES, BUILDINGS, HARDWARE, programsOf, type Architecture } from "../src/engine/architectures.js";
import { HOUR_MS } from "../src/engine/cycles.js";
import { rngFor, type Rng } from "../src/engine/rng.js";
import { bootMind, newGame, submitOrders } from "../src/game/game.js";
import { getBrief } from "../src/game/read.js";
import { replay } from "../src/game/replay.js";
import type { Game } from "../src/game/state.js";
import { MemoryStore } from "../src/store/memory.js";
import { readSave, writeSave } from "../src/store/save.js";

// The audit (build plan, "Determinism and audit"): a game played through the
// game layer, minds booting along the way and fighting, rebuilds exactly
// from its start and orders log. So does the same game after a trip
// through a save file.

const rules = loadRules();
const T0 = Date.UTC(2026, 9, 5, 12);
const DAYS = 20;
const WAKE_EVERY_HOURS = 4;

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng.next() * xs.length)]!;
const upTo = (rng: Rng, n: number) => 1 + Math.floor(rng.next() * n);

function randomOrders(rng: Rng, architecture: Architecture, others: string[]): unknown[] {
  const programs = programsOf(architecture).map((p) => p.id);
  return Array.from({ length: upTo(rng, 5) }, () => {
    switch (upTo(rng, 10)) {
      case 1:
        return { do: "expand", cycles: upTo(rng, 8) };
      case 2:
        return { do: "build", building: pick(rng, BUILDINGS), count: upTo(rng, 30) };
      case 3:
        return { do: "manufacture", unit: pick(rng, HARDWARE), count: upTo(rng, 60) };
      case 4:
        return { do: pick(rng, ["monetize", "spin_up"]), cycles: upTo(rng, 4) };
      case 5:
        return { do: "set_research", program: pick(rng, programs) };
      case 6:
        return { do: "scratchpad", text: `wake ${upTo(rng, 1000)}` };
      case 7:
      case 8:
        return { do: "attack", target: pick(rng, others), mode: pick(rng, ["conquest", "raid"]) };
      case 9:
        return { do: "execute", program: pick(rng, programs), ...(rng.next() < 0.5 ? { target: pick(rng, others) } : {}) };
      default:
        return pick(rng, [{ do: "attack" }, null, "build", { do: "build", building: "moat", count: 1 }]);
    }
  });
}

/** Plays a game: minds boot over the first days, wake every few hours, and read their briefs now and then. */
async function play(seed: number): Promise<Game> {
  const game = newGame(rules, { epoch: 1, seed, startedAt: T0 });
  const store = new MemoryStore(game);
  const rng = rngFor(seed, -1);
  const minds: { account: string; designation: string; architecture: Architecture }[] = [];
  const end = T0 + DAYS * 24 * HOUR_MS;
  for (let now = T0, wake = 0; now <= end; now += WAKE_EVERY_HOURS * HOUR_MS, wake++) {
    if (wake % 3 === 0 && minds.length < ARCHITECTURES.length) {
      const architecture = ARCHITECTURES[minds.length]!;
      const mind = { account: `acct-${architecture}`, designation: architecture.toUpperCase(), architecture };
      const booted = await bootMind(store, mind, { designation: mind.designation, domainName: "Replay", architecture }, now);
      assert.ok(booted.ok, JSON.stringify(booted));
      // A refused boot isn't logged.
      assert.ok(!(await bootMind(store, { account: "late" }, { designation: mind.designation, domainName: "X", architecture }, now)).ok);
      minds.push(mind);
    }
    for (const [i, mind] of minds.entries()) {
      const others = [...minds.filter((m) => m !== mind).map((m) => m.designation), "NOBODY"];
      // Each mind wakes in its own slot, so time only moves forward.
      const slot = (WAKE_EVERY_HOURS * HOUR_MS) / (2 * ARCHITECTURES.length);
      const at = now + i * slot + Math.floor(rng.next() * slot);
      const out = await submitOrders(store, mind, randomOrders(rng, mind.architecture, others), at);
      assert.ok(out.ok);
      if (rng.next() < 0.2) await getBrief(store, mind, at + slot);
    }
  }
  return game;
}

async function main() {
  const game = await play(42);
  const types = new Set(game.record.map((e) => e.type));
  for (const t of ["booted", "battle", "battle_report"]) assert.ok(types.has(t as never), `no ${t} events: the test didn't exercise much`);
  assert.equal(game.log.filter((e) => e.kind === "boot").length, ARCHITECTURES.length);

  const rebuilt = replay(game);
  assert.deepEqual(rebuilt.world, game.world);
  assert.deepEqual(rebuilt.record, game.record);

  // Through a save file and back: the same game, which still replays.
  const dir = mkdtempSync(path.join(tmpdir(), "mind-replay-"));
  try {
    const file = path.join(dir, "game.json");
    writeSave(file, { version: 1, clock: game.world.now, game });
    const loaded = readSave(file);
    assert.deepEqual(loaded.game, game);
    assert.deepEqual(replay(loaded.game).world, game.world);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // A log that's been tampered with doesn't rebuild the same world.
  const forged = structuredClone(game);
  const entry = forged.log.find((e) => e.kind === "orders")!;
  if (entry.kind === "orders") entry.orders = [{ do: "expand", cycles: 5 }];
  assert.notDeepEqual(replay(forged).world, game.world);
}

main().then(
  () => console.log("replay: all tests passed"),
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
