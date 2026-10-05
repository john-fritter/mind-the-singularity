import { fork } from "node:child_process";
import { availableParallelism } from "node:os";
import path from "node:path";
import type { Rules } from "../engine/rules.js";
import type { Players, StrategyName } from "../players/settings.js";
import { runEpoch, type EpochResult } from "./epoch.js";

// Many epochs, spread over child processes. Each epoch is a pure function of
// its inputs and seed, so how many processes ran them changes nothing.

export interface SimOptions {
  rules: Rules;
  settings: Players;
  epochs: number;
  strategies: StrategyName[];
  minds: number;
  days: number;
  /** Epoch i is seeded seed + i. */
  seed: number;
  /** Processes to run epochs in; 1 runs them in this one. */
  jobs: number;
}

/** What a worker is sent: everything but the seeds is the same for each epoch. */
export interface WorkerTask {
  rules: Rules;
  settings: Players;
  strategies: StrategyName[];
  minds: number;
  days: number;
  seeds: number[];
}

export type WorkerMessage = { result: EpochResult } | { error: string };

export const defaultJobs = () => Math.max(1, availableParallelism());

/** Runs the epochs, calling `progress` as each finishes. Results come back in seed order. */
export async function simulate(o: SimOptions, progress: (done: number) => void = () => {}): Promise<EpochResult[]> {
  const seeds = Array.from({ length: o.epochs }, (_, i) => o.seed + i);
  const results: EpochResult[] = [];
  const finish = (r: EpochResult) => {
    results.push(r);
    progress(results.length);
  };
  const jobs = Math.min(o.jobs, seeds.length);
  if (jobs <= 1) {
    for (const seed of seeds) finish(await runEpoch({ ...o, seed }));
  } else {
    // Dealt round-robin so each process gets early and late seeds alike.
    const shares = Array.from({ length: jobs }, (_, j) => seeds.filter((_, i) => i % jobs === j));
    await Promise.all(shares.map((share) => inWorker({ rules: o.rules, settings: o.settings, strategies: o.strategies, minds: o.minds, days: o.days, seeds: share }, finish)));
  }
  return results.sort((a, b) => a.seed - b.seed);
}

function inWorker(task: WorkerTask, finish: (r: EpochResult) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    // The child inherits this process's flags, tsx's loader among them.
    const child = fork(path.join(import.meta.dirname, "worker.ts"));
    let failed: string | undefined;
    child.on("message", (m: WorkerMessage) => {
      if ("error" in m) failed = m.error;
      else finish(m.result);
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 && !failed ? resolve() : reject(new Error(failed ?? `a simulator process exited with ${code}`))));
    child.send(task);
  });
}
