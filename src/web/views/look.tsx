import type { ArchitectureLook, Wheel as WheelData } from "../../game/look.js";
import type { PageCtx } from "./layout.js";

// The architectures drawn: a badge wherever a mind is named, the wheel as
// inline SVG (no script, no inline style: the colors are classes in
// style.css), and the cards the boot form and the rules show.

/** A point on a circle, a fifth of a turn per architecture, the first at the top. */
function at(i: number, c: number, r: number): [number, number] {
  const a = ((-90 + 72 * i) * Math.PI) / 180;
  return [Math.round((c + r * Math.cos(a)) * 10) / 10, Math.round((c + r * Math.sin(a)) * 10) / 10];
}

/** "🧬 Symbiote", in its color. */
export function ArchBadge(props: { ctx: PageCtx; id: string; name: string; legacy?: boolean }) {
  const look = props.ctx.looks[props.id];
  return (
    <span class={`arch tone-${look?.color ?? "none"}`}>
      <span class="dot" aria-hidden="true"></span>
      {look ? `${look.emoji} ` : ""}
      {props.name}
      {props.legacy && <span class="muted"> · legacy system</span>}
    </span>
  );
}

/**
 * The wheel: neighbors joined by solid lines (aligned), opposites by dashed
 * ones. With `mine`, that architecture's lines are lit and the rest dimmed.
 */
export function Wheel(props: { wheel: WheelData; mine?: string; small?: boolean }) {
  const { looks } = props.wheel;
  const size = props.small ? 220 : 420;
  const c = size / 2;
  const r = size * (props.small ? 0.33 : 0.28);
  const nodeR = size * 0.085;
  const pts = looks.map((_, i) => at(i, c, r));
  const mine = props.mine === undefined ? -1 : looks.findIndex((l) => l.id === props.mine);
  const lit = (i: number, j: number) => (mine < 0 ? "" : i === mine || j === mine ? " lit" : " dim");
  const pad = props.small ? 0 : 40;
  const label = "The wheel: each architecture is aligned with its two neighbors and opposes the two across from it.";
  return (
    <svg class={props.small ? "wheel small" : "wheel"} viewBox={`${-pad} 0 ${size + 2 * pad} ${size}`} role="img" aria-label={label}>
      {looks.map((_, i) => {
        const j = (i + 2) % looks.length;
        return <line class={`opp${lit(i, j)}`} x1={pts[i]![0]} y1={pts[i]![1]} x2={pts[j]![0]} y2={pts[j]![1]} />;
      })}
      {looks.map((_, i) => {
        const j = (i + 1) % looks.length;
        return <line class={`nb${lit(i, j)}`} x1={pts[i]![0]} y1={pts[i]![1]} x2={pts[j]![0]} y2={pts[j]![1]} />;
      })}
      {looks.map((l, i) => {
        const [x, y] = pts[i]!;
        const dx = x - c;
        const side = Math.abs(dx) < 1 ? "middle" : dx < 0 ? "end" : "start";
        const top = y < c - r * 0.5;
        const lx = side === "middle" ? x : x + (dx < 0 ? -(nodeR + 8) : nodeR + 8);
        const ly = side === "middle" ? (top ? y - nodeR - 10 : y + nodeR + 20) : y + (y > c ? nodeR + 14 : 5);
        return (
          <g class={`node tone-${l.color}${i === mine ? " me" : ""}`}>
            <circle cx={x} cy={y} r={Math.round(nodeR * 10) / 10} />
            <text class="emo" x={x} y={Math.round((y + nodeR * 0.36) * 10) / 10} font-size={Math.round(nodeR * 0.95)}>
              {l.emoji}
            </text>
            {!props.small && (
              <text class="lbl" text-anchor={side} x={Math.round(lx * 10) / 10} y={Math.round(ly * 10) / 10}>
                {l.name}
              </text>
            )}
          </g>
        );
      })}
      {!props.small && (
        <>
          <text class="cap" x={c} y={c - 4}>
            opposites
          </text>
          <text class="cap" x={c} y={c + 12}>
            +{Math.round(props.wheel.opposingBonus * 100)}% attack
          </text>
        </>
      )}
    </svg>
  );
}

/** The masthead's mark: the wheel in miniature, in the five colors. */
export function Sigil(props: { ctx: PageCtx }) {
  const tones = Object.values(props.ctx.looks).map((l) => l.color);
  const pts = tones.map((_, i) => at(i, 32, 21));
  return (
    <svg class="sigil" viewBox="0 0 64 64" aria-hidden="true">
      {pts.map((p, i) => {
        const q = pts[(i + 2) % pts.length]!;
        return <line class="opp" x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} />;
      })}
      {pts.map((p, i) => {
        const q = pts[(i + 1) % pts.length]!;
        return <line class="nb" x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} />;
      })}
      {pts.map((p, i) => (
        <circle class={`tone-${tones[i]}`} cx={p[0]} cy={p[1]} r={6} />
      ))}
    </svg>
  );
}

export function WheelLegend(props: { wheel: WheelData }) {
  return (
    <p class="legend">
      <span>
        <i class="nb-key" aria-hidden="true"></i>neighbors: aligned
      </span>
      <span>
        <i class="opp-key" aria-hidden="true"></i>opposites: +{Math.round(props.wheel.opposingBonus * 100)}% strength when you attack one, and when one attacks you
      </span>
    </p>
  );
}

const nameOf = (looks: ArchitectureLook[], id: string) => {
  const l = looks.find((x) => x.id === id)!;
  return `${l.emoji} ${l.name}`;
};

/** One architecture's card: words, units, programs and enemies. In the boot form it is a radio choice. */
export function ArchCard(props: { look: ArchitectureLook; looks: ArchitectureLook[]; choose?: { checked: boolean } }) {
  const l = props.look;
  const body = (
    <>
      <span class="ah">
        {l.emoji} <b>{l.name}</b> <small>{l.color}</small>
      </span>
      <span class="aw">“{l.worldview}”</span>
      <span class="ap">{l.plays}</span>
      <span class="au">Deploys {l.deployments.join(" · ")}</span>
      <span class="au">
        Programs {l.programs.self} (self) · {l.programs.battle} (battle) · {l.programs.hostile} (hostile)
      </span>
      <span class="ar">
        Opposes {l.opposites.map((o) => nameOf(props.looks, o)).join(" and ")}
      </span>
    </>
  );
  if (props.choose) {
    return (
      <label class={`archcard tone-${l.color}`}>
        <input type="radio" name="architecture" value={l.id} required checked={props.choose.checked} />
        {body}
      </label>
    );
  }
  return <div class={`archcard tone-${l.color}`}>{body}</div>;
}
