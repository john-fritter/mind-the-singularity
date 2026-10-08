/**
 * The cast (phase 6c): drafts mind profiles with a model, and compiles the
 * kept ones into personas and bots for the runner.
 *
 * Usage:
 *   npm run cast -- generate <N>   draft profiles 1..N that aren't drafted yet (one model call each)
 *   npm run cast -- compile        write each kept profile's persona and the cast's bots file
 *   npm run cast -- list           the drafts and the kept profiles
 *
 * Knobs are config/runner.yaml's `cast`. The generator's key is the cast's
 * model_key_env in runner.env, as the bots' are.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import YAML from "yaml";
import { loadRules, loadSite } from "../config.js";
import {
  compileCast,
  deal,
  generationMessages,
  parseProfile,
  profileFile,
  profileSchema,
  retryMessage,
  TemplateSchema,
  type CastRules,
  type Profile,
  type Taken,
  type Template,
} from "./cast.js";
import { NanoGptModel, type ChatMessage } from "./model.js";
import { loadRunner, ROOT, type CastSettings, type RunnerSettings } from "./settings.js";

dotenv.config({ path: path.join(ROOT, "runner.env"), quiet: true });

const USAGE = `Usage:
  npm run cast -- generate <N>
  npm run cast -- compile
  npm run cast -- list`;

/** The game's flavor limits and architectures, from the config the runner may read. */
export function castRules(): CastRules {
  const rules = loadRules();
  const site = loadSite();
  const architectures: CastRules["architectures"] = {};
  for (const [id, a] of Object.entries(rules.architectures)) {
    const look = site.architectures[id as keyof typeof site.architectures];
    architectures[id] = { name: a.name, worldview: look.worldview, plays: look.plays };
  }
  return { limits: rules.flavor, architectures };
}

export function loadTemplate(cast: CastSettings): Template {
  return TemplateSchema.parse(YAML.parse(readFileSync(path.resolve(ROOT, cast.template), "utf-8")));
}

/** The profiles in a directory, by file name. */
export function readProfiles(dir: string, rules: CastRules): { file: string; profile: Profile }[] {
  const abs = path.resolve(ROOT, dir);
  if (!existsSync(abs)) return [];
  const schema = profileSchema(rules);
  return readdirSync(abs)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((file) => {
      const result = schema.safeParse(YAML.parse(readFileSync(path.join(abs, file), "utf-8")));
      if (!result.success) throw new Error(`${dir}/${file} is invalid:\n${result.error.message}`);
      return { file, profile: result.data };
    });
}

function castOf(settings: RunnerSettings): CastSettings {
  if (!settings.cast) throw new Error("config/runner.yaml has no `cast` section.");
  return settings.cast;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function generate(settings: RunnerSettings, n: number): Promise<void> {
  const cast = castOf(settings);
  const rules = castRules();
  const template = loadTemplate(cast);
  const key = process.env[cast.model_key_env];
  if (!key) throw new Error(`${cast.model_key_env} isn't set in runner.env.`);
  const model = new NanoGptModel(key, {
    baseUrl: settings.nanogpt_base_url,
    timeoutSeconds: settings.model_timeout_seconds,
    maxOutputTokens: settings.max_output_tokens,
  });
  const dir = path.resolve(ROOT, cast.drafts_dir);
  mkdirSync(dir, { recursive: true });
  const slots = deal(template, Object.keys(rules.architectures), cast.generator.seed, n);
  const pad = (i: number) => String(i).padStart(2, "0");
  let spent = 0;
  let calls = 0;
  for (const slot of slots) {
    const existing = readdirSync(dir).find((f) => f.startsWith(`${pad(slot.index)}-`));
    if (existing) continue;
    // Everything drafted or kept so far, so this one doesn't repeat it.
    const earlier = [...readProfiles(cast.drafts_dir, rules), ...readProfiles(cast.profiles_dir, rules)].map((p) => p.profile);
    const taken: Taken = {
      designations: earlier.map((p) => p.designation),
      domainNames: earlier.map((p) => p.domain_name),
      origins: earlier.map((p) => p.origin.split(/(?<=\.)\s/)[0]!),
    };
    const messages: ChatMessage[] = generationMessages(template, rules, slot, n, taken);
    let profile: Profile | null = null;
    for (let attempt = 0; attempt < 2 && !profile; attempt++) {
      let res;
      try {
        res = await model.complete({ model: cast.generator.model, messages, reasoningEffort: cast.generator.reasoning_effort, json: false });
      } catch (err) {
        console.error(`  ${pad(slot.index)}: ${err instanceof Error ? err.message : String(err)}`);
        if (attempt === 0) await sleep(settings.retry_wait_seconds * 1000);
        continue;
      } finally {
        calls++;
      }
      spent += res.usage.promptTokens + res.usage.completionTokens;
      const parsed = parseProfile(res.content, rules);
      if ("profile" in parsed) {
        profile = parsed.profile;
      } else {
        console.error(`  ${pad(slot.index)}: ${parsed.problem.split("\n").slice(0, 4).join(" ")}`);
        if (res.content?.trim()) messages.push({ role: "assistant", content: res.content });
        messages.push(retryMessage(parsed.problem));
      }
    }
    if (!profile) {
      console.error(`${pad(slot.index)}: no usable profile after a retry; run generate again to try it once more.`);
      continue;
    }
    if (taken.designations.includes(profile.designation)) {
      console.error(`${pad(slot.index)}: ${profile.designation} is taken; run generate again to redraw it.`);
      continue;
    }
    const file = `${pad(slot.index)}-${profile.designation.toLowerCase()}.yaml`;
    writeFileSync(path.join(dir, file), profileFile(profile, slot));
    console.log(`${pad(slot.index)} ${profile.designation} (${profile.architecture}): ${profile.domain_name}`);
  }
  console.log(`${calls} model calls, ${spent} tokens.`);
}

function compile(settings: RunnerSettings): void {
  const cast = castOf(settings);
  const rules = castRules();
  const kept = readProfiles(cast.profiles_dir, rules);
  const { personas, file } = compileCast(
    kept.map((k) => k.profile),
    rules,
    cast,
  );
  const own = new Set(settings.bots.map((b) => b.name).filter((name) => !personas.has(name)));
  for (const name of personas.keys()) if (own.has(name)) throw new Error(`The cast's bot "${name}" has the name of a bot in config/runner.yaml.`);
  const dir = path.resolve(ROOT, cast.personas_dir);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of personas) writeFileSync(path.join(dir, `${name}.md`), text);
  writeFileSync(path.resolve(ROOT, cast.out), file);
  console.log(`${personas.size} bots compiled into ${cast.out}: ${[...personas.keys()].join(", ")}.`);
}

function list(settings: RunnerSettings): void {
  const cast = castOf(settings);
  const rules = castRules();
  for (const [label, dir] of [
    ["Drafts", cast.drafts_dir],
    ["Kept", cast.profiles_dir],
  ] as const) {
    const profiles = readProfiles(dir, rules);
    console.log(`${label} (${dir}): ${profiles.length}`);
    for (const { file, profile } of profiles) console.log(`  ${file}  ${profile.designation} (${profile.architecture}), ${profile.domain_name}`);
  }
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  const settings = loadRunner();
  if (command === "generate") {
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1) throw new Error(USAGE);
    await generate(settings, n);
  } else if (command === "compile") compile(settings);
  else if (command === "list") list(settings);
  else throw new Error(USAGE);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
