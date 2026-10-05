import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// The lines between modules, checked from their source:
// - src/engine/ is pure: it imports only itself and zod, and never reads the
//   clock or Math.random (time and a seeded RNG are passed in);
// - the runner is an MCP client: src/runner/ imports only itself and the
//   config loaders, never the engine, the game layer, the store or the MCP
//   server;
// - the MCP server and the web view go through src/game/, never the store;
// - only src/game/ calls the engine's entry points (engine/world.ts), so
//   every write goes through its checks and its log;
// - scripted players see what an agent sees: src/players/ reaches the game
//   through src/game/, and takes from the engine only ids, types and pure
//   formulas, never the world, its state or the order code.
// A directory that doesn't exist yet passes trivially.

const SRC = path.join(import.meta.dirname, "..", "src");

/** What src/players/ may import from outside itself. */
const PLAYERS_MAY_IMPORT = [
  "game/game.js",
  "game/read.js",
  "game/state.js",
  "store/store.js",
  ...["architectures", "combat", "context", "cycles", "economy", "names", "power", "programs", "rng", "rules", "units"].map((m) => `engine/${m}.js`),
];

async function files(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Source with comments removed, so a comment naming Date.now() is fine. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Every module specifier a source file imports, statically or dynamically. */
function specifiers(source: string): string[] {
  const code = stripComments(source);
  const out: string[] = [];
  for (const m of code.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g)) out.push(m[1]!);
  return out;
}

/**
 * What's wrong with an engine file, given its path relative to src/. Empty
 * when it's pure.
 */
function engineProblems(file: string, source: string): string[] {
  const problems: string[] = [];
  for (const spec of specifiers(source)) {
    if (spec.startsWith(".")) {
      const target = path.relative(SRC, path.resolve(path.dirname(path.join(SRC, file)), spec));
      if (!target.startsWith("engine/")) problems.push(`${file} imports ${target}: the engine imports only itself`);
    } else if (spec !== "zod") {
      problems.push(`${file} imports ${spec}: the engine may import only zod`);
    }
  }
  const code = stripComments(source);
  if (/\bDate\.now\s*\(/.test(code)) problems.push(`${file} calls Date.now(): pass the time in`);
  if (/\bnew\s+Date\s*\(\s*\)/.test(code)) problems.push(`${file} calls new Date(): pass the time in`);
  if (/\bMath\.random\b/.test(code)) problems.push(`${file} uses Math.random: use the seeded RNG`);
  if (/\bperformance\.now\b/.test(code)) problems.push(`${file} reads performance.now: pass the time in`);
  return problems;
}

/** Relative imports of a directory's files, as paths relative to src/. */
async function importsOf(dir: string): Promise<{ file: string; target: string }[]> {
  const out: { file: string; target: string }[] = [];
  for (const file of await files(path.join(SRC, dir))) {
    for (const spec of specifiers(await readFile(file, "utf-8"))) {
      if (!spec.startsWith(".")) continue;
      out.push({ file: path.relative(SRC, file), target: path.relative(SRC, path.resolve(path.dirname(file), spec)) });
    }
  }
  return out;
}

function checkTheChecker() {
  const pure = `import { z } from "zod";\nimport { x } from "./rules.js";\n// never call Date.now() here\nexport const f = (now: Date) => new Date(now.getTime());`;
  assert.deepEqual(engineProblems("engine/a.ts", pure), []);

  const impure = [
    `import { readFileSync } from "node:fs";`,
    `import { loadRules } from "../config.js";`,
    `const t = Date.now();`,
    `const d = new Date();`,
    `const r = Math.random();`,
    `const m = await import("../store/memory.js");`,
  ].join("\n");
  const problems = engineProblems("engine/a.ts", impure);
  for (const needle of ["node:fs", "config.js", "Date.now", "new Date", "Math.random", "store/memory.js"]) {
    assert.ok(problems.some((p) => p.includes(needle)), `the engine check misses ${needle}`);
  }
}

async function main() {
  checkTheChecker();

  for (const file of await files(path.join(SRC, "engine"))) {
    const problems = engineProblems(path.relative(SRC, file), await readFile(file, "utf-8"));
    assert.deepEqual(problems, []);
  }

  for (const { file, target } of await importsOf("runner")) {
    assert.ok(
      target.startsWith("runner/") || target === "config.js",
      `${file} imports ${target}: the runner reaches the game only through MCP`,
    );
  }

  for (const dir of ["cli", "mcp", "web", "store", "db", "players", "sim", "auth", "runner"]) {
    for (const { file, target } of await importsOf(dir)) {
      assert.ok(target !== "engine/world.js", `${file} imports engine/world.js: write through src/game/`);
    }
  }

  for (const { file, target } of await importsOf("players")) {
    assert.ok(
      target.startsWith("players/") || PLAYERS_MAY_IMPORT.includes(target),
      `${file} imports ${target}: a player sees only its brief, the rules and their formulas`,
    );
  }

  for (const dir of ["mcp", "web"]) {
    for (const { file, target } of await importsOf(dir)) {
      assert.ok(!target.startsWith("store/"), `${file} imports ${target}: go through src/game/`);
    }
  }
}

main()
  .then(() => console.log("boundaries: all tests passed"))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
