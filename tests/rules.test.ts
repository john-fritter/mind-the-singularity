import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { epochOfDays, loadRules, parseRules, RULES_PATH } from "../src/config.js";
import { DAY_MS } from "../src/engine/cycles.js";
import { newGame } from "../src/game/game.js";

// config/rules.yaml loads, and the schema refuses anything incomplete or
// inconsistent, so a number can't go missing quietly.

const text = readFileSync(RULES_PATH, "utf-8");

/** The real rules with one change applied, as YAML. */
function variant(change: (doc: any) => void): string {
  const doc = YAML.parse(text);
  change(doc);
  return YAML.stringify(doc);
}

function rejects(change: (doc: any) => void, needle: string) {
  assert.throws(() => parseRules(variant(change)), (err: Error) => {
    assert.ok(err.message.includes(needle), `expected "${needle}" in:\n${err.message}`);
    return true;
  });
}

function main() {
  const rules = loadRules();
  assert.equal(rules.cycles.interval_minutes, 30);
  assert.equal(rules.cycles.cap, 96);
  assert.equal(rules.action_cycles.attack, 2);
  assert.equal(loadRules(), rules, "loaded once per process");

  // Missing, misspelled and wrong-typed keys.
  rejects((d) => delete d.cycles.cap, "cap");
  rejects((d) => (d.cycles.capp = 96), "capp");
  rejects((d) => (d.cycles.cap = "96"), "cap");
  rejects((d) => delete d.flavor, "flavor");
  rejects((d) => (d.newsection = {}), "newsection");

  // Out of range.
  rejects((d) => (d.cycles.cap = 0), "cap");
  rejects((d) => (d.combat.random_spread = 1), "random_spread");
  rejects((d) => (d.cycles.cap = 2.5), "cap");

  // Inconsistent.
  rejects((d) => (d.protection.range_min = 1.5), "range_min");
  rejects((d) => (d.convergence.quorum_min = 8), "quorum_min must not exceed quorum_max");
  rejects((d) => (d.convergence.join_gap_hours = 72), "join_gap_hours");
  rejects((d) => (d.epoch.shutdown_warning_days = 60), "shutdown_warning_days");
  rejects((d) => (d.social.protocol_max_members = 4), "protocol_max_members");

  // Every id in src/engine/architectures.ts needs an entry, and no other.
  rejects((d) => delete d.architectures.steward.programs.hardening, "hardening");
  rejects((d) => delete d.architectures.oracle.deployments.ghosts, "ghosts");
  rejects((d) => (d.architectures.oracle.deployments.wraiths = d.architectures.oracle.deployments.ghosts), "wraiths");
  rejects((d) => delete d.buildings.lab, "lab");
  rejects((d) => (d.start.buildings.castle = 1), "castle");
  rejects((d) => delete d.hardware.walkers, "walkers");
  rejects((d) => (d.architectures.steward.programs.hardening.duration.unit = "days"), "unit");
  rejects((d) => (d.research.tier_by_kind.self = 4), "tier_by_kind");
  rejects((d) => (d.research.cost_by_tier = [4000, 12000]), "cost_by_tier");
  rejects((d) => (d.architectures.symbiote.programs.blight.capital_share = 1.5), "capital_share");

  // The starting domain must be a legal domain.
  rejects((d) => (d.start.buildings.core = 0), "at least one core");
  rejects((d) => (d.start.territory = 50), "start has 80 buildings on 50 sectors");
  rejects((d) => (d.start.users = 100000), "start users exceed");
  rejects((d) => (d.start.compute = 100000), "start compute exceeds");
  rejects((d) => (d.start.hardware.walkers = 1000), "start hardware exceeds");

  // Numbers that must keep their order.
  rejects((d) => (d.research.cost_by_tier = [4000, 3000, 30000]), "cost_by_tier must rise with tier");
  rejects((d) => (d.programs.deploy.compute_by_tier = [500, 500, 3000]), "compute_by_tier must rise with tier");
  rejects((d) => (d.capability.crash_min = 0.2), "crash_min must not exceed");
  rejects((d) => (d.combat.winner_loss_max = 0.15), "winner_loss_max must be below loser_loss_base");
  rejects((d) => (d.combat.lopsided_ratio = 1), "lopsided_ratio");
  rejects((d) => (d.programs.singularity.cycles = 97), "the Singularity costs more cycles than the cap");

  // Legacy systems.
  rejects((d) => (d.legacy.systems[0].orders.expand = 0.5), "shares must add up to 1");
  rejects((d) => (d.legacy.systems[1].designation = d.legacy.systems[0].designation), "legacy designations must be unique");
  rejects((d) => (d.legacy.systems[0].designation = "X".repeat(41)), "longer than flavor.designation");
  rejects((d) => (d.legacy.systems[0].architecture = "druid"), "architecture");
  rejects((d) => (d.legacy.raid_every_hours_min = 100), "raid_every_hours_min");

  // One epoch started shorter by hand (epoch -- new --days, phase 6d): only
  // its own copy of the rules changes, and it ends on its own day.
  {
    const rules = loadRules();
    const short = epochOfDays(rules, 40);
    assert.equal(short.epoch.length_days, 40);
    assert.notEqual(rules.epoch.length_days, 40, "config/rules.yaml's rules are untouched");
    const game = newGame(short, { epoch: 1, seed: 1, startedAt: 0 });
    assert.equal(game.rules.epoch.length_days, 40, "the epoch keeps its length");
    assert.equal(game.world.timers.find((t) => t.kind === "shutdown")!.at, 40 * DAY_MS, "the Shutdown on day 40");
    assert.throws(() => epochOfDays(rules, rules.epoch.shutdown_warning_days), /shutdown_warning_days must be shorter/);
    assert.throws(() => epochOfDays(rules, 0), /--days 0 is invalid/);
  }

  // The error names the source.
  assert.throws(() => parseRules("cycles: {}", "test.yaml"), /test\.yaml is invalid/);
}

main();
console.log("rules: all tests passed");
