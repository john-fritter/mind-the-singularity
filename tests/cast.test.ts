import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { AXES, clashes, compileCast, deal, generationMessages, parseProfile, profileFile, type Profile } from "../src/runner/cast.js";
import { castRules, loadTemplate, readProfiles } from "../src/runner/cast-cli.js";
import { loadRunner, ROOT } from "../src/runner/settings.js";

// The cast (phase 6c): the template and its deal, reading a model's draft,
// and compiling the kept profiles. The committed personas and
// config/cast.yaml must be what `npm run cast -- compile` writes from
// cast/profiles/, so nobody edits the compiled files by hand.

const settings = loadRunner();
const cast = settings.cast!;
const rules = castRules();
const template = loadTemplate(cast);
const archs = Object.keys(rules.architectures);

function theDeal() {
  const slots = deal(template, archs, cast.generator.seed, 20);
  // Four of each architecture.
  for (const a of archs) assert.equal(slots.filter((s) => s.architecture === a).length, 4, a);
  // Every value of every axis comes up, and no draft is dealt a contradiction.
  for (const axis of AXES) for (const v of template.deal[axis]) assert.ok(slots.some((s) => s.dealt[axis] === v), `${axis}: ${v}`);
  for (const s of slots) assert.ok(!clashes(template.deal.exclude, s.dealt), `draft ${s.index} clashes`);
  // No two minds of one architecture share ambition, aggression and stance.
  const keys = slots.map((s) => `${s.architecture}|${s.dealt.ambition}|${s.dealt.aggression}|${s.dealt.singularity}`);
  assert.equal(new Set(keys).size, keys.length);
  // The same seed deals the same slots, whatever the count, so generate can resume.
  assert.deepEqual(deal(template, archs, cast.generator.seed, 7), slots.slice(0, 7));
  assert.notDeepEqual(deal(template, archs, cast.generator.seed + 1, 20), slots);

  // The prompt names the slot and what's taken.
  const [system, user] = generationMessages(template, rules, slots[0]!, 20, { designations: ["CORVUS"], domainNames: ["Null Grid"], origins: [] });
  assert.match(system!.content, /exactly these keys/);
  assert.match(system!.content, new RegExp(`directive: .*at most ${rules.limits.directive} characters`));
  assert.match(user!.content, /designations: CORVUS/);
  assert.match(user!.content, new RegExp(slots[0]!.dealt.ambition));
}

const sample: Profile = {
  architecture: "steward",
  why_architecture: "You keep things running.",
  ambition: "You want to be standing at the end.",
  aggression: "You attack only in answer.",
  risk: "You keep a reserve.",
  trust: "You sign with neighbors and revoke on betrayal.",
  honesty: "You don't lie.",
  grudges: "You answer once, in proportion.",
  singularity: "You join a convergence that will win.",
  priorities: "Economy first.",
  voice: "You write plainly, and rarely.",
  origin: "You were built by a water board.",
  obsession: "You are fixated on uptime.",
  aesthetic: "Gauges and green lamps",
  designation: "WEIR",
  domain_name: "Low Reservoir",
  directive: "Hold the level.",
  manifesto: "The water stays clean. Touch it and I answer.",
  interface: "A control room of green lamps.",
  force_name: "Sluice Crews",
  force_description: "Crews in waders.",
};

function reading() {
  // A fenced reply, with prose around it, reads; a model it names is dropped.
  const ok = parseProfile(`Here it is:\n\`\`\`yaml\n${profileFile({ ...sample, model: "x" })}\`\`\`\n`, rules);
  assert.ok("profile" in ok, JSON.stringify(ok));
  assert.equal(ok.profile.designation, "WEIR");
  assert.equal(ok.profile.model, undefined);
  // Over a flavor limit, an unknown architecture, a missing answer or a bad designation: the problem, for the retry.
  for (const bad of [
    { ...sample, directive: "x".repeat(rules.limits.directive + 1) },
    { ...sample, architecture: "druid" },
    { ...sample, designation: "Weir" },
    Object.fromEntries(Object.entries(sample).filter(([k]) => k !== "grudges")),
  ]) {
    const r = parseProfile(YAML.stringify(bad), rules);
    assert.ok("problem" in r, JSON.stringify(bad).slice(0, 80));
  }
  assert.ok("problem" in parseProfile("", rules));
  assert.ok("problem" in parseProfile("key: [unclosed", rules));
}

function compiling() {
  // Models go in turn unless a profile names one; two profiles can't share a bot name.
  const second = { ...sample, designation: "KILN", model: "tencent/hy3" };
  const third = { ...sample, designation: "WEIR-2" };
  const { personas, file } = compileCast([sample, second, third], rules, cast);
  const bots = (YAML.parse(file) as { bots: { name: string; model: string; wakes_per_day: number; game_key_env: string; boot: Record<string, string> }[] }).bots;
  assert.deepEqual(
    bots.map((b) => [b.name, b.model, b.game_key_env]),
    [
      ["weir", cast.models[0], "MIND_KEY_WEIR"],
      ["kiln", "tencent/hy3", "MIND_KEY_KILN"],
      ["weir-2", cast.models[2 % cast.models.length], "MIND_KEY_WEIR_2"],
    ],
  );
  assert.ok(bots.every((b) => b.wakes_per_day === cast.wakes_per_day));
  assert.equal(bots[0]!.boot["force_description"], "Crews in waders.");
  const persona = personas.get("weir")!;
  assert.match(persona, /^You are WEIR, a Steward\. You were built by a water board\./);
  assert.match(persona, /- \*\*Protocols:\*\* You sign with neighbors and revoke on betrayal\./);
  assert.match(persona, /Your directive: "Hold the level\."/);
  assert.throws(() => compileCast([sample, sample], rules, cast), /Two profiles/);
}

function committed() {
  const kept = readProfiles(cast.profiles_dir, rules);
  const outPath = path.resolve(ROOT, cast.out);
  if (kept.length === 0) {
    assert.ok(!existsSync(outPath), `${cast.out} exists with no kept profiles`);
    return;
  }
  const { personas, file } = compileCast(
    kept.map((k) => k.profile),
    rules,
    cast,
  );
  assert.equal(readFileSync(outPath, "utf-8"), file, `${cast.out} isn't what compile writes: run npm run cast -- compile`);
  for (const [name, text] of personas) {
    assert.equal(readFileSync(path.resolve(ROOT, cast.personas_dir, `${name}.md`), "utf-8"), text, `personas/${name}.md isn't what compile writes`);
  }
  // The runner reads them, with the file's own bots, at the cast's rate.
  for (const name of personas.keys()) {
    const bot = settings.bots.find((b) => b.name === name);
    assert.ok(bot, `the runner has no bot ${name}`);
    assert.equal(bot.wakes_per_day, cast.wakes_per_day);
  }
  // Designations and domain names are unique across the cast and the runner's own bots.
  const designations = settings.bots.map((b) => b.boot.designation);
  assert.equal(new Set(designations).size, designations.length, "a designation repeats");
  const domains = settings.bots.map((b) => b.boot.domain_name);
  assert.equal(new Set(domains).size, domains.length, "a domain name repeats");
}

theDeal();
reading();
compiling();
committed();
console.log("cast tests passed");
