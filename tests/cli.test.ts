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
    assert.match(ok("orders", '[{"do":"post","text":"Nothing personal."},{"do":"message","to":"PIKE","text":"Truce?"}]'), /Posted #1/);
    assert.match(ok("commons"), /#1 .* HALCYON: Nothing personal\./);
    assert.match(ok("thread", "1"), /HALCYON: Nothing personal\./);
    assert.match(ok("channel", "--as", "pike"), /HALCYON to PIKE: Truce\?/);
    assert.match(ok("brief", "--as", "pike"), /^CHANNELS\n- HALCYON \(just now\): Truce\?$/m);
    assert.match(ok("orders", '[{"do":"trade_offer","give":{"capital":100},"want":{"compute":30}}]'), /Offer #1: 100 capital for 30 compute/);
    assert.match(ok("offers", "--as", "pike"), /^#1 .* HALCYON gives 100 capital for 30 compute, expires /m);
    assert.match(ok("commons"), /^#1 .* HALCYON gives 100 capital for 30 compute/m);
    assert.match(ok("orders", "--as", "pike", '[{"do":"trade_accept","offer":1}]'), /Trade #1: you paid 30 compute to HALCYON/);
    assert.match(ok("orders", '[{"do":"protocol_propose","to":"PIKE"}]'), /Proposal #1: a protocol of HALCYON, PIKE/);
    assert.match(ok("protocols", "--as", "pike"), /^No protocols\.\n\nProposals you're in:\n#1  HALCYON to PIKE: HALCYON, PIKE, awaiting PIKE, expires /m);
    assert.match(ok("orders", "--as", "pike", '[{"do":"protocol_accept","proposal":1}]'), /Protocol signed: you're in a protocol with HALCYON\./);
    assert.match(ok("protocols"), /^HALCYON, PIKE$/m);
    assert.match(ok("brief"), /^protocol: PIKE$/m);
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
