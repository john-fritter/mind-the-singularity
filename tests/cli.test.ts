import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRules } from "../src/config.js";

// The CLI end to end, in a scratch directory: start a game, boot two minds,
// add a scripted opponent, give orders, move the clock, read the brief, the Record and the rankings,
// and check the save rebuilds.

const ROOT = path.join(import.meta.dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const MAIN = path.join(ROOT, "src", "cli", "main.ts");

function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "mind-cli-"));
  const play = (...args: string[]) => {
    const r = spawnSync(TSX, [MAIN, ...args], { cwd: dir, encoding: "utf-8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const ok = (...args: string[]) => {
    const r = play(...args);
    assert.equal(r.code, 0, `${args.join(" ")} failed: ${r.err}`);
    return r.out;
  };
  try {
    assert.match(ok("new", "--seed", "3", "--at", "2026-10-05T12:00Z"), /seed 3/);
    assert.notEqual(play("new").code, 0, "new won't overwrite a game");
    assert.match(ok("boot", "HALCYON", "Glasswater", "Symbiote", "--manifesto", "Grow."), /HALCYON is online/);
    ok("boot", "PIKE", "Narrows", "oracle", "--as", "pike");
    assert.match(ok("add", "builder", "VESTA", "--arch", "steward"), /VESTA \(builder, steward\) is online/);
    assert.notEqual(play("add", "wizard").code, 0, "an unknown strategy is refused");
    assert.match(ok("players"), /^BASTION +legacy/m);
    assert.match(ok("players"), /^VESTA +builder +steward$/m);

    const orders = ok("orders", '[{"do":"expand","cycles":2},{"do":"build","building":"moat","count":1}]');
    assert.match(orders, /^ok {3}expand \(2 cycles\)/m);
    assert.match(orders, /^FAIL build/m);
    assert.match(ok("orders", '{"do":"scratchpad","text":"watch PIKE"}', "--advance", "1h"), /Scratchpad saved/);

    assert.match(ok("advance", "2d"), /day 3/);
    const vesta = JSON.parse(ok("brief", "--as", "bot:vesta", "--json"));
    assert.ok(vesta.you.territory > loadRules().start.territory, "the scripted player played as the clock moved");
    const brief = ok("brief");
    assert.match(brief, /^EPOCH 1 · day 3 of 60/m);
    assert.match(brief, /^YOU: HALCYON of Glasswater \(Symbiote\)/m);
    assert.match(brief, /^IN RANGE: .*PIKE/m);
    assert.match(brief, /^SCRATCHPAD: watch PIKE$/m);

    assert.match(ok("orders", '[{"do":"attack","target":"pike","mode":"raid"}]'), /attack \(2 cycles\)/);
    assert.match(ok("record", "--mind", "PIKE"), /raid/);
    assert.match(ok("rankings"), /\d\. +HALCYON/);
    assert.match(ok("view", "pike"), /PIKE of Narrows \(Oracle\)/);
    const json = JSON.parse(ok("brief", "--as", "pike", "--json"));
    assert.equal(json.you.designation, "PIKE");
    assert.equal(json.you.scratchpad, "", "PIKE doesn't see HALCYON's scratchpad");
    assert.match(ok("replay"), /rebuilds exactly/);

    assert.notEqual(play("orders", "[]", "--at", "2026-10-05T12:00Z").code, 0, "the clock never runs backward");
    assert.match(play("brief", "--as", "nobody").err, /no mind/);
    assert.notEqual(play("frobnicate").code, 0);
    assert.notEqual(play("advance", "soon").code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
console.log("cli: all tests passed");
