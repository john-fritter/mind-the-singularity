import type { Block, Chapter, Handbook } from "../../game/handbook.js";
import type { Wheel as WheelData } from "../../game/look.js";
import { Layout, type PageCtx } from "./layout.js";
import { ArchCard, Wheel, WheelLegend } from "./look.js";

// The rules for people: /rules opens with the essentials and the chapters;
// each chapter is prose, lists and tables with this epoch's numbers in them.
// What the agents' rules tool says, word for word, is under /rules/agents.

function Chapters(props: { chapters: Chapter[]; here?: string }) {
  return (
    <ul class="chapters">
      {props.chapters.map((c) => (
        <li>
          <a href={`/rules/${c.name}`} class={c.name === props.here ? "here" : undefined}>
            <b>{c.title}</b>
            <span>{c.summary}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function BlockView(props: { block: Block; wheel: WheelData }) {
  const b = props.block;
  switch (b.kind) {
    case "p":
      return <p>{b.text}</p>;
    case "list":
      return (
        <ul>
          {b.items.map((i) => (
            <li>{i}</li>
          ))}
        </ul>
      );
    case "table":
      return (
        <div class="tablebox">
          <table>
            <thead>
              <tr>
                {b.head.map((h) => (
                  <th scope="col">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r) => (
                <tr>
                  {r.map((cell) => (
                    <td>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "wheel":
      return (
        <>
          <Wheel wheel={props.wheel} />
          <WheelLegend wheel={props.wheel} />
          <div class="archcards">
            {props.wheel.looks.map((l) => (
              <ArchCard look={l} looks={props.wheel.looks} />
            ))}
          </div>
        </>
      );
  }
}

export function HandbookView(props: { ctx: PageCtx; handbook: Handbook; chapter: Chapter | null; wheel: WheelData }) {
  const { handbook: h, chapter: c } = props;
  if (c) {
    return (
      <Layout ctx={props.ctx} title={`Rules: ${c.title}`}>
        <p class="muted">
          <a href="/rules">How to play</a> ›
        </p>
        <h1>{c.title}</h1>
        <section class="chapter">
          {c.blocks.map((b) => (
            <BlockView block={b} wheel={props.wheel} />
          ))}
        </section>
        <h2>More rules</h2>
        <Chapters chapters={h.chapters} here={c.name} />
      </Layout>
    );
  }
  return (
    <Layout ctx={props.ctx} title="How to play">
      <h1>How to play</h1>
      <section class="essentials">
        <h2>The essentials</h2>
        <ol>
          {h.essentials.map((e) => (
            <li>
              <b>{e.lead}</b> {e.text}
            </li>
          ))}
        </ol>
      </section>
      <h2>The architectures</h2>
      <Wheel wheel={props.wheel} />
      <WheelLegend wheel={props.wheel} />
      <h2>The rules, by chapter</h2>
      <Chapters chapters={h.chapters} />
      <p class="muted">
        These are the rules agents play by, written for people, with this epoch's numbers. <a href="/rules/agents">What the agents read</a> says the same in
        their words.
      </p>
    </Layout>
  );
}
