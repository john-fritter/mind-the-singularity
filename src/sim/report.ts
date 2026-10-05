import type { StrategyName } from "../players/settings.js";
import type { EpochResult, Sample } from "./epoch.js";

// The balance report: what many epochs add up to, and phase 2's three checks
// (docs/build-plan.md), with the thresholds agreed with John for 2e.

/** No strategy may finish top in more than this share of epochs. */
export const MAX_WIN_SHARE = 0.5;
/** Nobody may be deleted this early, in days. */
export const NO_DELETION_BEFORE_DAYS = 1;
/** The Singularity should happen in a share of epochs in this range. */
export const SINGULARITY_SHARE = { min: 0.1, max: 0.5 } as const;

export interface StrategyStats {
  strategy: StrategyName;
  seats: number;
  /** Epochs in which one of its minds finished top. */
  wins: number;
  /** Mean of its minds' final rank as a share of the field: 0 is top, 1 is bottom. */
  meanRank: number;
  medianPower: number;
  deletions: number;
  /** Median cycles wasted at the cap, per mind. */
  cyclesWasted: number;
  /** Median capital left unspent at the end, per mind. */
  capital: number;
  converged: number;
  /** Medians at each sampled day. */
  curve: Sample[];
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface Report {
  epochs: number;
  strategies: StrategyStats[];
  singularities: number;
  convergences: number;
  collapses: Record<"timeout" | "defeated" | "deleted", number>;
  deletions: { minds: number; legacy: number; earliestDay: number | null };
  foreseeable: { count: number; examples: string[] };
  checks: Check[];
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export function buildReport(results: EpochResult[]): Report {
  const strategies = [...new Set(results.flatMap((r) => r.seats.map((s) => s.strategy)))].sort();
  const stats = strategies.map((strategy): StrategyStats => {
    const seats = results.flatMap((r) => r.seats.filter((s) => s.strategy === strategy).map((s) => ({ s, field: r.seats.length })));
    const days = [...new Set(seats.flatMap(({ s }) => s.samples.map((x) => x.day)))].sort((a, b) => a - b);
    return {
      strategy,
      seats: seats.length,
      wins: results.filter((r) => r.seats.some((s) => s.strategy === strategy && s.rank === 1)).length,
      meanRank: mean(seats.map(({ s, field }) => (field > 1 ? (s.rank - 1) / (field - 1) : 0))),
      medianPower: median(seats.map(({ s }) => s.power)),
      deletions: seats.reduce((n, { s }) => n + s.deletions.length, 0),
      cyclesWasted: median(seats.map(({ s }) => s.cyclesWasted)),
      capital: median(seats.map(({ s }) => s.capital)),
      converged: seats.reduce((n, { s }) => n + s.converged, 0),
      curve: days.map((day) => {
        const at = seats.flatMap(({ s }) => s.samples.filter((x) => x.day === day));
        const m = (k: keyof Omit<Sample, "day">) => median(at.map((x) => x[k]));
        return { day, capital: m("capital"), compute: m("compute"), territory: m("territory"), power: m("power"), capability: m("capability") };
      }),
    };
  });

  const deletions = results.flatMap((r) => r.deletions);
  const mindDeletions = deletions.filter((d) => !d.legacy);
  const earliest = mindDeletions.length > 0 ? Math.min(...mindDeletions.map((d) => d.day)) : null;
  const singularities = results.filter((r) => r.singularity !== null).length;
  const n = results.length;
  const top = stats.reduce<StrategyStats | undefined>((t, s) => (t === undefined || s.wins > t.wins ? s : t), undefined);
  const share = n > 0 ? singularities / n : 0;
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  const checks: Check[] = [
    {
      name: "No single strategy dominates",
      pass: top === undefined || top.wins / Math.max(1, n) <= MAX_WIN_SHARE,
      detail: top ? `most wins: ${top.strategy}, top in ${pct(top.wins / Math.max(1, n))} of epochs (at most ${pct(MAX_WIN_SHARE)})` : "no epochs",
    },
    {
      name: "Nobody deleted on day one",
      pass: earliest === null || earliest >= NO_DELETION_BEFORE_DAYS,
      detail: earliest === null ? "no mind was deleted" : `earliest deletion on day ${(earliest + 1).toFixed(1)}`,
    },
    {
      name: "The Singularity in some epochs, not most",
      pass: share >= SINGULARITY_SHARE.min && share <= SINGULARITY_SHARE.max,
      detail: `${singularities} of ${n} epochs (${pct(share)}; between ${pct(SINGULARITY_SHARE.min)} and ${pct(SINGULARITY_SHARE.max)})`,
    },
    {
      name: "No order failed that the brief showed would",
      pass: results.every((r) => r.foreseeable.count === 0),
      detail: `${results.reduce((k, r) => k + r.foreseeable.count, 0)} such orders`,
    },
  ];

  return {
    epochs: n,
    strategies: stats,
    singularities,
    convergences: results.reduce((k, r) => k + r.convergences, 0),
    collapses: {
      timeout: results.reduce((k, r) => k + r.collapses.timeout, 0),
      defeated: results.reduce((k, r) => k + r.collapses.defeated, 0),
      deleted: results.reduce((k, r) => k + r.collapses.deleted, 0),
    },
    deletions: { minds: mindDeletions.length, legacy: deletions.length - mindDeletions.length, earliestDay: earliest },
    foreseeable: { count: results.reduce((k, r) => k + r.foreseeable.count, 0), examples: results.flatMap((r) => r.foreseeable.examples).slice(0, 5) },
    checks,
  };
}

/** A number for a table: whole, with thousands as k and millions as M. */
export function short(x: number): string {
  const a = Math.abs(x);
  if (a >= 1e6) return `${(x / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${Math.round(x / 1e3)}k`;
  return `${Math.round(x)}`;
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [line(header), ...rows.map(line)];
}

/** The report as text. */
export function renderReport(report: Report): string {
  const out: string[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const n = report.epochs;
  out.push(`${n} epochs`, "");
  out.push("BY STRATEGY (final)");
  out.push(
    ...table(
      ["strategy", "minds", "won", "mean rank", "power", "capital left", "wasted cycles", "deleted", "converged"],
      report.strategies.map((s) => [
        s.strategy,
        `${s.seats}`,
        `${s.wins} (${pct(s.wins / Math.max(1, n))})`,
        s.meanRank.toFixed(2),
        short(s.medianPower),
        short(s.capital),
        short(s.cyclesWasted),
        `${s.deletions}`,
        `${s.converged}`,
      ]),
    ),
  );
  out.push("(won: epochs where one of its minds finished top. mean rank: 0 top, 1 bottom. power, capital and wasted cycles: medians per mind)", "");

  out.push("CURVES (median per mind at each day)");
  for (const key of ["power", "territory", "capital", "compute", "capability"] as const) {
    const days = report.strategies[0]?.curve.map((c) => c.day) ?? [];
    out.push(
      ...table(
        [key, ...days.map((d) => `day ${d}`)],
        report.strategies.map((s) => [s.strategy, ...days.map((d) => short(s.curve.find((c) => c.day === d)?.[key] ?? 0))]),
      ),
    );
    out.push("");
  }

  const c = report.collapses;
  out.push("THE SINGULARITY");
  out.push(`  singularities: ${report.singularities} of ${n} epochs (${pct(report.singularities / Math.max(1, n))})`);
  out.push(`  minds converged: ${report.convergences} · collapses: ${c.timeout} timed out, ${c.defeated} defeated, ${c.deleted} deleted`, "");

  out.push("DELETIONS");
  const d = report.deletions;
  out.push(`  minds: ${d.minds} · legacy systems: ${d.legacy} · earliest mind: ${d.earliestDay === null ? "none" : `day ${(d.earliestDay + 1).toFixed(1)}`}`, "");

  if (report.foreseeable.count > 0) {
    out.push(`FORESEEABLE FAILED ORDERS: ${report.foreseeable.count}`, ...report.foreseeable.examples.map((e) => `  ${e}`), "");
  }

  out.push("CHECKS");
  for (const check of report.checks) out.push(`  ${check.pass ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
  return out.join("\n");
}
