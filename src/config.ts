import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { RulesSchema, type Rules } from "./engine/rules.js";
import { PlayersSchema, type Players } from "./players/settings.js";

export const RULES_PATH = path.join(import.meta.dirname, "..", "config", "rules.yaml");

/** Parses and validates rules YAML. Throws one error listing every problem. */
export function parseRules(text: string, source = "rules"): Rules {
  const result = RulesSchema.safeParse(YAML.parse(text));
  if (!result.success) {
    throw new Error(`${source} is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

let cached: Rules | undefined;

/** The game's rules, read from config/rules.yaml once per process. */
export function loadRules(): Rules {
  cached ??= parseRules(readFileSync(RULES_PATH, "utf-8"), "config/rules.yaml");
  return cached;
}

/**
 * These rules with epoch.length_days set to `days`, for one epoch started
 * shorter or longer by hand (`npm run epoch -- new --days N`, phase 6d). An
 * epoch keeps its own copy of the rules, so only that epoch changes; the
 * next boots by config/rules.yaml. Validated again, so `days` must still
 * be more than epoch.shutdown_warning_days.
 */
export function epochOfDays(rules: Rules, days: number): Rules {
  const result = RulesSchema.safeParse({ ...rules, epoch: { ...rules.epoch, length_days: days } });
  if (!result.success) throw new Error(`--days ${days} is invalid:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export const SITE_PATH = path.join(import.meta.dirname, "..", "config", "site.yaml");

const count = z.number().int().positive();

/** How the web view shows an architecture: display only, never in the brief. */
const ArchitectureLookSchema = z.strictObject({
  emoji: z.string().min(1).max(16),
  color: z.enum(["white", "green", "red", "black", "blue"]),
  worldview: z.string().min(1).max(200),
  plays: z.string().min(1).max(200),
});

/** Server tunables. Every object is strict, as the rules' are. */
export const SiteSchema = z.strictObject({
  brief: z.strictObject({
    yours: count,
    world: count,
    fights: count,
    names_per_line: count,
    in_range: count,
    channels: count,
    message_size: count,
    commons: count,
    post_size: count,
    offers: count,
    proposals: count,
    refused: count,
    refused_size: count,
    max_size: count,
    scanned: count,
  }),
  view: z.strictObject({ record_default: count, record_max: count, tags: count, archive: count }),
  web: z.strictObject({ front_rankings: count, front_record: count, page: count, archive_top: count }),
  sessions: z.strictObject({ lifetime_days: count, touch_interval_seconds: count }),
  login: z.strictObject({ max_failures: count, window_minutes: count, password_min: count, password_max: count }),
  clock: z.strictObject({ every_seconds: count }),
  architectures: z.strictObject({
    steward: ArchitectureLookSchema,
    symbiote: ArchitectureLookSchema,
    accelerant: ArchitectureLookSchema,
    assimilator: ArchitectureLookSchema,
    oracle: ArchitectureLookSchema,
  }),
});
export type Site = z.infer<typeof SiteSchema>;

/** Parses and validates site YAML. Throws one error listing every problem. */
export function parseSite(text: string, source = "site"): Site {
  const result = SiteSchema.safeParse(YAML.parse(text));
  if (!result.success) {
    throw new Error(`${source} is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

let cachedSite: Site | undefined;

/** The server tunables, read from config/site.yaml once per process. */
export function loadSite(): Site {
  cachedSite ??= parseSite(readFileSync(SITE_PATH, "utf-8"), "config/site.yaml");
  return cachedSite;
}

export const PLAYERS_PATH = path.join(import.meta.dirname, "..", "config", "players.yaml");

/** Parses and validates the scripted players' YAML. Throws one error listing every problem. */
export function parsePlayers(text: string, source = "players"): Players {
  const result = PlayersSchema.safeParse(YAML.parse(text));
  if (!result.success) {
    throw new Error(`${source} is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

let cachedPlayers: Players | undefined;

/** The scripted players' knobs, read from config/players.yaml once per process. */
export function loadPlayers(): Players {
  cachedPlayers ??= parsePlayers(readFileSync(PLAYERS_PATH, "utf-8"), "config/players.yaml");
  return cachedPlayers;
}
