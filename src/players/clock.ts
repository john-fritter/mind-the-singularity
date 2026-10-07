import { currentMind } from "../game/game.js";
import type { WorldStore } from "../store/store.js";
import { legacySeats, scriptedSeat, wake, wakesBetween, type Seat, type WakeLog } from "./drive.js";
import type { Players, StrategyName } from "./settings.js";

// The server's clock for the players that run in it: the legacy systems
// and the scripted players seated in the epoch (`npm run epoch -- add`).
// `npm start` calls pass() on a light timer; each pass runs every wake
// that fell due since the last one, through the same wake() the CLI and
// the simulator use, so each is a brief, a decision and a submitOrders.
//
// Two differences from the CLI's drive(), both because real time moves on
// its own here:
// - A wake runs at the moment of the pass, not at the minute it fell due:
//   a person's or an agent's orders may already have moved the game's
//   clock past that minute, and the game never runs backward. The orders
//   log keeps the real moment, so the epoch still replays.
// - Nothing is caught up from before the server started: a scripted
//   player misses the wakes of a downtime, as an absent agent would. A
//   legacy system counts its wakes from the epoch's start, so its growth
//   catches up anyway.

/** A scripted player seated in an epoch, as the database keeps it. */
export interface SeatRow {
  account: string;
  strategy: StrategyName;
  seed: number;
  boot: NonNullable<Seat["boot"]>;
}

export interface ClockDeps {
  /** The current epoch's game, or null when there's none. */
  current(): Promise<WorldStore | null>;
  /** The scripted players seated in an epoch, by its number. */
  seats(epoch: number): Promise<SeatRow[]>;
  settings: Players;
}

export class ServerClock {
  /** When each epoch was last passed over. */
  private last = new Map<number, number>();
  private busy = false;

  /** `startedAt` is when the server started: no wake from before it runs. */
  constructor(
    private readonly deps: ClockDeps,
    private readonly startedAt: number,
  ) {}

  /** Runs every wake due since the last pass, each seat at most once. A pass that finds one still running does nothing. */
  async pass(now: number): Promise<WakeLog[]> {
    if (this.busy) return [];
    this.busy = true;
    try {
      return await this.run(now);
    } finally {
      this.busy = false;
    }
  }

  private async run(now: number): Promise<WakeLog[]> {
    const store = await this.deps.current();
    if (!store) return [];
    const game = await store.read();
    if (game.world.ended) return [];
    const epoch = game.start.epoch;
    // An epoch that started after the server did gets its first wakes too.
    const from = this.last.get(epoch) ?? Math.max(this.startedAt, game.start.startedAt - 1);
    const scripted = (await this.deps.seats(epoch)).map((row) => scriptedSeat(this.deps.settings, row));
    const seats = [...legacySeats(game.rules), ...scripted];

    // Due on the schedule, and any scripted player just seated: it boots now.
    const due: Seat[] = [];
    for (const { seat } of wakesBetween(seats, game.start.startedAt, from, now)) if (!due.includes(seat)) due.push(seat);
    for (const seat of scripted) if (!due.includes(seat) && currentMind(game, seat.account) === undefined) due.push(seat);

    const logs: WakeLog[] = [];
    for (const seat of due) {
      const latest = await store.read();
      if (latest.world.ended) break;
      logs.push(await wake(store, seat, Math.max(now, latest.world.now), this.deps.settings.steps_per_wake));
    }
    this.last.set(epoch, now);
    return logs;
  }
}
