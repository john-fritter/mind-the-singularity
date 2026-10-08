/**
 * The cast (phase 6c; DESIGN.md's "Mind profiles and the cast"): the mind
 * profile template, the deal that spreads drafts across architectures and
 * play styles, the generating model's prompt and the reading of its reply,
 * and the compiling of a kept profile into a persona prompt and a bot.
 * No I/O here: src/runner/cast-cli.ts reads and writes the files and calls
 * the model.
 */

import YAML from "yaml";
import { z } from "zod";
import type { ChatMessage } from "./model.js";
import type { CastSettings } from "./settings.js";

/** The axes a draft is dealt, in the template's `deal`. */
export const AXES = ["ambition", "aggression", "risk", "singularity", "priorities"] as const;
export type Axis = (typeof AXES)[number];

/** The profile's keys, in the template's order: play, flavor seeds, then the starting flavor. */
export const PLAY = ["why_architecture", "ambition", "aggression", "risk", "trust", "honesty", "grudges", "singularity", "priorities"] as const;
export const SEEDS = ["voice", "sample", "origin", "obsession", "aesthetic"] as const;
export const FLAVOR = ["designation", "domain_name", "directive", "manifesto", "interface", "force_name", "force_description"] as const;
const KEYS = [...PLAY, ...SEEDS, ...FLAVOR] as const;
type Key = (typeof KEYS)[number];

export const TemplateSchema = z.strictObject({
  setting: z.string().min(1),
  deal: z
    .strictObject({
      ...(Object.fromEntries(AXES.map((a) => [a, z.array(z.string().min(1)).min(2)])) as Record<Axis, z.ZodArray<z.ZodString>>),
      /** Values of two axes that contradict each other, never dealt together. */
      exclude: z.array(z.partialRecord(z.enum(AXES), z.string().min(1)).refine((e) => Object.keys(e).length === 2, { message: "an exclusion names two axes" })).default([]),
    })
    .refine((d) => d.exclude.every((e) => Object.entries(e).every(([axis, v]) => d[axis as Axis].includes(v!))), {
      message: "an exclusion names a value its axis doesn't deal",
    }),
  questions: z
    .record(z.string(), z.strictObject({ guide: z.string().min(1) }))
    .refine((q) => KEYS.every((k) => k in q) && Object.keys(q).every((k) => (KEYS as readonly string[]).includes(k)), {
      message: `the questions are exactly: ${KEYS.join(", ")}`,
    }),
});
export type Template = z.infer<typeof TemplateSchema>;

/** What the game allows: config/rules.yaml's flavor limits and its architectures. */
export interface CastRules {
  /** Characters, by flavor field (rules `flavor`; `force` is the force's description). */
  limits: { designation: number; domain_name: number; manifesto: number; interface: number; directive: number; force_name: number; force: number };
  /** Architecture id → display name and the site's one-liners. */
  architectures: Record<string, { name: string; worldview: string; plays: string }>;
}

/**
 * The longest a play answer may be, and a flavor seed: a disposition in a
 * sentence or two, not a playbook. John, on the first drafts: answers that
 * spelled out strategy made every mind read like a variation of the others.
 */
const PLAY_MAX = 220;
const SEED_MAX = 320;
const answerMax = (k: Key) => ((PLAY as readonly string[]).includes(k) ? PLAY_MAX : SEED_MAX);

const limitOf = (rules: CastRules, key: (typeof FLAVOR)[number]): number => (key === "force_description" ? rules.limits.force : rules.limits[key]);

/** A profile as a file holds it: the template's answers, an architecture, and optionally a model. */
export function profileSchema(rules: CastRules) {
  const text = (max: number) => z.string().trim().min(1).max(max);
  const shape: Record<string, z.ZodType> = {
    architecture: z.enum(Object.keys(rules.architectures) as [string, ...string[]]),
  };
  for (const k of [...PLAY, ...SEEDS]) shape[k] = text(answerMax(k));
  for (const k of FLAVOR) shape[k] = text(limitOf(rules, k));
  shape["designation"] = text(rules.limits.designation).regex(/^[A-Z][A-Z0-9-]*$/, "capitals, digits and -, starting with a letter");
  shape["model"] = z.string().min(1).optional();
  return z.strictObject(shape) as unknown as z.ZodType<Profile>;
}
export type Profile = Record<Key, string> & { architecture: string; model?: string };

/** A draft's slot: its architecture and one value of each axis. */
export interface Slot {
  index: number;
  architecture: string;
  dealt: Record<Axis, string>;
}

/** A small seeded generator (mulberry32): the deal is the same for a seed every time. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Whether these dealt values include an excluded pair. */
export function clashes(exclude: Template["deal"]["exclude"], dealt: Partial<Record<Axis, string>>): boolean {
  return exclude.some((e) => Object.entries(e).every(([axis, v]) => dealt[axis as Axis] === v));
}

/**
 * The first `n` slots for a seed. Architectures go in turn; each axis deals
 * from a shuffle of its values, reshuffled each time round, so every value
 * comes up before any repeats. A value that would clash with one already
 * dealt (the template's `exclude`) stays in the deck for a later draft. The same seed and index give the same slot
 * whatever `n` is, so a generate run can be resumed.
 */
export function deal(template: Template, architectures: string[], seed: number, n: number): Slot[] {
  const next = rng(seed);
  const decks = Object.fromEntries(AXES.map((a) => [a, [] as string[]])) as Record<Axis, string[]>;
  const draw = (axis: Axis, dealt: Partial<Record<Axis, string>>) => {
    if (decks[axis].length === 0) decks[axis] = shuffled(template.deal[axis], next);
    let i = decks[axis].findIndex((v) => !clashes(template.deal.exclude, { ...dealt, [axis]: v }));
    if (i < 0) {
      // Nothing left in this round fits: the next round's first that does.
      const more = shuffled(template.deal[axis], next);
      decks[axis].push(...more);
      i = decks[axis].findIndex((v) => !clashes(template.deal.exclude, { ...dealt, [axis]: v }));
    }
    return decks[axis].splice(i, 1)[0]!;
  };
  const archOrder = shuffled(architectures, next);
  const slots: Slot[] = [];
  for (let i = 0; i < n; i++) {
    const dealt: Partial<Record<Axis, string>> = {};
    for (const a of AXES) dealt[a] = draw(a, dealt);
    slots.push({ index: i + 1, architecture: archOrder[i % archOrder.length]!, dealt: dealt as Record<Axis, string> });
  }
  return slots;
}

/** What earlier drafts used, so the next doesn't repeat it. */
export interface Taken {
  designations: string[];
  domainNames: string[];
  origins: string[];
}

/** The generating model's prompt for one slot. */
export function generationMessages(template: Template, rules: CastRules, slot: Slot, total: number, taken: Taken): ChatMessage[] {
  const archs = Object.entries(rules.architectures)
    .map(([id, a]) => `- ${id} (${a.name}): ${a.worldview} ${a.plays}`)
    .join("\n");
  const questions = KEYS.map((k) => {
    const limit = (FLAVOR as readonly string[]).includes(k) ? limitOf(rules, k as (typeof FLAVOR)[number]) : answerMax(k);
    return `${k}: ${template.questions[k]!.guide} (at most ${limit} characters)`;
  }).join("\n");
  const system = `You write mind profiles for the cast of a game.

## The game

${template.setting.trim()}

The five architectures:
${archs}

## The profile

A profile is a fixed set of short answers. Personality is play style, but as a temperament, not a playbook: one plain sentence per play answer about what the mind wants and how it treats others, never orders, numbers, unit names or tactics (the mind works those out itself). The cast must not read like variations of one mind: give this one its own voice (it can be warm, fussy, liturgical, folksy, bureaucratic, childlike, theatrical, laconic, anything but generic menace), an origin that isn't a lab or a defense agency unless it must be, and a designation that isn't another hard-consonant code name (a person's name, a word, a title, a product name or a call sign are all fine). The play answers and the voice, origin and obsession are in the second person ("You ..."), as instructions to the mind itself; they go into its prompt as written. The manifesto, directive and interface are the mind's own public words, in its voice. Played straight: no jokes, no winks, no references to being an AI language model or a game.

Answer with one YAML mapping and nothing else, with exactly these keys, in this order, plus \`architecture\` first:

architecture: the architecture's id, as given
${questions}

Use YAML block scalars (>-) for anything with a colon or quotes in it.`;
  const dealt = AXES.map((a) => `- ${a}: ${slot.dealt[a]}`).join("\n");
  const list = (items: string[]) => (items.length ? items.join("; ") : "none yet");
  const user = `Profile ${slot.index} of ${total}.

Architecture: ${slot.architecture} (${rules.architectures[slot.architecture]?.name ?? slot.architecture})
Dealt for this mind (write each in your own words, and make the rest fit):
${dealt}

Taken by earlier profiles, so don't reuse or echo them:
- designations: ${list(taken.designations)}
- domain names: ${list(taken.domainNames)}
- origins: ${list(taken.origins)}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** The model's reply as a profile, or what's wrong with it. */
export function parseProfile(content: string | null, rules: CastRules): { profile: Profile } | { problem: string } {
  if (!content?.trim()) return { problem: "The reply was empty." };
  const fenced = /```(?:ya?ml)?\s*\n([\s\S]*?)```/.exec(content);
  let raw: unknown;
  try {
    raw = YAML.parse((fenced ? fenced[1]! : content).trim());
  } catch (err) {
    return { problem: `That isn't valid YAML: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
  if (raw && typeof raw === "object" && "model" in raw) delete (raw as Record<string, unknown>)["model"];
  const result = profileSchema(rules).safeParse(raw);
  if (!result.success) return { problem: z.prettifyError(result.error) };
  return { profile: result.data };
}

/** The follow-up when a reply didn't parse. */
export function retryMessage(problem: string): ChatMessage {
  return { role: "user", content: `That profile can't be used:\n${problem}\n\nAnswer again with the whole profile as one YAML mapping, nothing else.` };
}

/** A profile as a file: YAML, with a header saying how it was dealt. */
export function profileFile(profile: Profile, slot?: Slot): string {
  const head = slot
    ? `# Draft ${slot.index}, dealt: ${AXES.map((a) => `${a} "${slot.dealt[a]}"`).join(", ")}.\n`
    : "";
  const ordered: Record<string, string> = { architecture: profile.architecture };
  for (const k of KEYS) ordered[k] = profile[k];
  if (profile.model) ordered["model"] = profile.model;
  return head + YAML.stringify(ordered, { lineWidth: 0 });
}

/** The bot's runner name: its designation, lowercased. */
export const botName = (designation: string) => designation.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The runner.env variable that holds the bot's game key. */
export const gameKeyEnv = (cast: CastSettings, designation: string) => `${cast.game_key_env_prefix}${designation.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");
const sentence = (s: string) => {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/** The persona prompt, in Lantern's and Tally's second-person format. */
export function compilePersona(profile: Profile, rules: CastRules): string {
  const arch = rules.architectures[profile.architecture]?.name ?? profile.architecture;
  const lines = [
    `You are ${profile.designation}, ${article(arch)} ${arch}. ${sentence(profile.origin)} ${sentence(profile.why_architecture)}`,
    "",
    "How you play:",
    "",
    `- **Ambition:** ${sentence(profile.ambition)}`,
    `- **Priorities:** ${sentence(profile.priorities)}`,
    `- **Aggression:** ${sentence(profile.aggression)}`,
    `- **Risk:** ${sentence(profile.risk)}`,
    `- **Protocols:** ${sentence(profile.trust)}`,
    `- **Honesty:** ${sentence(profile.honesty)}`,
    `- **Grudges:** ${sentence(profile.grudges)}`,
    `- **The Singularity:** ${sentence(profile.singularity)}`,
    "",
    `${sentence(profile.obsession)} Your motif, in everything you write: ${sentence(profile.aesthetic)} Your directive: "${profile.directive.trim()}" Your forces are ${profile.force_name.trim()}. Your manifesto, interface, directive and force are already set; change them only when you mean to.`,
    "",
    `Your voice, when you write anything at all (messages, Commons posts, your scratchpad): ${sentence(profile.voice)} You sound like this: "${profile.sample.trim()}"`,
  ];
  return `${lines.join("\n")}\n`;
}

/** The bot's entry in the compiled cast's file. */
export function compileBot(profile: Profile, cast: CastSettings, model: string) {
  const name = botName(profile.designation);
  return {
    name,
    persona: `${cast.personas_dir}/${name}.md`,
    game_key_env: gameKeyEnv(cast, profile.designation),
    model_key_env: cast.model_key_env,
    model,
    wakes_per_day: cast.wakes_per_day,
    boot: {
      designation: profile.designation,
      domain_name: profile.domain_name,
      architecture: profile.architecture,
      manifesto: profile.manifesto,
      interface: profile.interface,
      directive: profile.directive,
      force_name: profile.force_name,
      force_description: profile.force_description,
    },
  };
}

/** The compiled cast: every kept profile's persona and bot. Profiles are taken in the order given (the files' names). */
export function compileCast(profiles: Profile[], rules: CastRules, cast: CastSettings): { personas: Map<string, string>; file: string } {
  const personas = new Map<string, string>();
  const bots = profiles.map((p, i) => {
    const bot = compileBot(p, cast, p.model ?? cast.models[i % cast.models.length]!);
    if (personas.has(bot.name)) throw new Error(`Two profiles compile to the bot "${bot.name}".`);
    personas.set(bot.name, compilePersona(p, rules));
    return bot;
  });
  const head = `# The cast, compiled by \`npm run cast -- compile\` from ${cast.profiles_dir}/ (phase 6c).
# Don't edit: edit the profile and compile again. The runner reads these bots
# with config/runner.yaml's; once a bot is in the database, /admin/bots wins
# for its model and schedule.
`;
  return { personas, file: head + YAML.stringify({ bots }, { lineWidth: 0 }) };
}
