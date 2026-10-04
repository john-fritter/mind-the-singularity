import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { loadRules, parseRules, RULES_PATH } from "../src/config.js";

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

  // The error names the source.
  assert.throws(() => parseRules("cycles: {}", "test.yaml"), /test\.yaml is invalid/);
}

main();
console.log("rules: all tests passed");
