import { runEpoch } from "./epoch.js";
import type { WorkerMessage, WorkerTask } from "./run.js";

// A simulator child process: runs its share of epochs and sends each result
// back as it finishes. See run.ts.

process.once("message", (task: WorkerTask) => {
  void (async () => {
    const send = (m: WorkerMessage) => new Promise<void>((resolve) => process.send!(m, () => resolve()));
    try {
      for (const seed of task.seeds) await send({ result: await runEpoch({ ...task, seed }) });
      process.exit(0);
    } catch (e) {
      await send({ error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
      process.exit(1);
    }
  })();
});
