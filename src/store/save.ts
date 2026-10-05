import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { RulesSchema } from "../engine/rules.js";
import type { Game } from "../game/state.js";

// A game on disk: one JSON file holding the game and the local clock it's
// played on (the CLI's; a live game runs on real time). Written to a
// temporary file and renamed over the old one, so a crash mid-write never
// leaves half a save.

export const SAVE_VERSION = 1;

export interface SaveFile {
  version: typeof SAVE_VERSION;
  /** The local game's clock, in milliseconds since the Unix epoch. */
  clock: number;
  game: Game;
}

// The rules are checked in full, since the game plays by them. The world,
// log and Record are the engine's own output, so only their shape is
// checked here; replay checks the rest.
const SaveSchema = z.strictObject({
  version: z.literal(SAVE_VERSION),
  clock: z.number().finite(),
  game: z.strictObject({
    rules: RulesSchema,
    start: z.strictObject({ epoch: z.number().int(), seed: z.number().int(), startedAt: z.number().finite() }),
    world: z.looseObject({ epoch: z.number(), now: z.number(), domains: z.array(z.unknown()), timers: z.array(z.unknown()) }),
    owners: z.array(z.strictObject({ account: z.string(), domain: z.number().int() })),
    log: z.array(z.looseObject({ kind: z.enum(["boot", "orders"]), at: z.number(), account: z.string(), seq: z.number() })),
    record: z.array(z.looseObject({ seq: z.number(), type: z.string() })),
  }),
});

export function readSave(file: string): SaveFile {
  const parsed = SaveSchema.safeParse(JSON.parse(readFileSync(file, "utf-8")));
  if (!parsed.success) throw new Error(`${file} isn't a save this version can read:\n${z.prettifyError(parsed.error)}`);
  return parsed.data as unknown as SaveFile;
}

export function writeSave(file: string, save: SaveFile): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(save));
  renameSync(tmp, file);
}
