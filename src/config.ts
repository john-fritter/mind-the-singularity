import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { RulesSchema, type Rules } from "./engine/rules.js";

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
