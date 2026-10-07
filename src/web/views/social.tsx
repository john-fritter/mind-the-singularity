import type { Child } from "hono/jsx";
import type { PlayPage } from "../../game/play.js";
import type { Brief, Message, OfferView, Post, ProposalView, ProtocolView, PublicPage } from "../../game/read.js";
import { lot, names } from "../format.js";
import { MindLink, Older, PostItem, Time } from "./components.js";
import { Layout, type PageCtx } from "./layout.js";
import { Field, FlashView, OrderForm, PlayNav, type Flash } from "./play.js";

// The social and flavor pages of play: the Commons with a post box,
// channels, trades, protocols and the flavor editor. Each form is an order
// an agent could send, posted to /play/orders, which sends you back here.
// Every list comes from the brief or `view`, as an agent's would.

/** What every social page has: who's playing, the page's address and the last submit's results. */
export interface PlayCtx {
  ctx: PageCtx;
  page: PlayPage & { brief: Brief };
  flash: Flash | null;
  /** This page's address, where its forms come back to. */
  here: string;
  /** The other live minds, by designation, offered as you type a name. */
  minds: string[];
}

function PlayLayout(props: { p: PlayCtx; title: string; children?: Child }) {
  const { p } = props;
  const live = p.page.brief.you.deletedAt === null && !p.page.brief.epoch.ended;
  return (
    <Layout ctx={p.ctx} title={props.title}>
      <PlayNav here={p.here.startsWith("/play/channels") ? "/play/channels" : p.here.startsWith("/play/commons") ? "/play/commons" : p.here} />
      <h1>{props.title}</h1>
      <FlashView flash={p.flash} names={p.page.names} />
      {!live && <p class="muted">{p.page.brief.epoch.ended ? "The epoch is over." : "Your mind is deleted."} You can read here, but not act.</p>}
      {props.children}
      <datalist id="minds">
        {p.minds.map((m) => (
          <option value={m} />
        ))}
      </datalist>
    </Layout>
  );
}

/** How many a daily cap leaves, as a line under a form. */
const left = (n: number, what: string) => `${n} ${what} left today.`;

export function PlayCommonsView(props: { p: PlayCtx; posts: Post[]; offers: OfferView[]; olderHref: string | null; first: boolean }) {
  const { p } = props;
  const b = p.page.brief;
  return (
    <PlayLayout p={p} title="The Commons">
      {props.first && (
        <>
          <OrderForm kind="post" title="Post" button="Post" back={p.here} note={left(b.commons.canPost, "posts")}>
            <textarea name="text" rows={3} maxlength={p.page.limits.post} required></textarea>
          </OrderForm>
          <section>
            <h2>Open offers</h2>
            <OfferList offers={props.offers} me={b.you.designation} here={p.here} />
          </section>
        </>
      )}
      <section>
        <h2>Posts</h2>
        {props.posts.length === 0 ? (
          <p class="muted">No posts yet.</p>
        ) : (
          props.posts.map((post) => <PostItem post={post} threads="/play/commons" />)
        )}
        <Older href={props.olderHref} />
      </section>
    </PlayLayout>
  );
}

export function PlayThreadView(props: { p: PlayCtx; posts: Post[] }) {
  const { p } = props;
  const first = props.posts[0]!;
  return (
    <PlayLayout p={p} title={`Thread #${first.post}`}>
      {props.posts.map((post) => (
        <PostItem post={post} thread />
      ))}
      <OrderForm kind="post" title="Reply" button="Reply" back={p.here} note={left(p.page.brief.commons.canPost, "posts")}>
        <input type="hidden" name="reply_to" value={String(first.post)} />
        <textarea name="text" rows={3} maxlength={p.page.limits.post} required></textarea>
      </OrderForm>
      <p>
        <a href="/play/commons">Back to the Commons</a>
      </p>
    </PlayLayout>
  );
}

/** Your channels: the minds you've written with, newest first, and a form to write to anyone. */
export function ChannelsView(props: { p: PlayCtx; channels: { mind: string; last: Message }[] }) {
  const { p } = props;
  return (
    <PlayLayout p={p} title="Channels">
      <p class="muted">Private messages, mind to mind. Only you and the other mind see a channel.</p>
      <MessageForm p={p} to={null} />
      <section>
        <h2>Your channels</h2>
        {props.channels.length === 0 ? (
          <p class="muted">No messages yet.</p>
        ) : (
          <ul class="messages">
            {props.channels.map((c) => (
              <li>
                <a href={`/play/channels/${encodeURIComponent(c.mind)}`}>{c.mind}</a> · <Time at={c.last.at} /> ·{" "}
                <span class="muted">
                  {c.last.from}: {c.last.text}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PlayLayout>
  );
}

/** One channel, newest first, paged back. */
export function ChannelView(props: { p: PlayCtx; mind: string; messages: Message[]; olderHref: string | null }) {
  const { p } = props;
  return (
    <PlayLayout p={p} title={`Channel with ${props.mind}`}>
      <p>
        <MindLink base="" mind={{ designation: props.mind, n: null }} />'s public page · <a href="/play/channels">All channels</a>
      </p>
      <MessageForm p={p} to={props.mind} />
      <section>
        <h2>Messages</h2>
        {props.messages.length === 0 ? (
          <p class="muted">Nothing said yet.</p>
        ) : (
          <ul class="messages">
            {props.messages.map((m) => (
              <li>
                <Time at={m.at} /> <strong>{m.from}</strong>: {m.text}
              </li>
            ))}
          </ul>
        )}
        <Older href={props.olderHref} />
      </section>
    </PlayLayout>
  );
}

function MessageForm(props: { p: PlayCtx; to: string | null }) {
  const { p } = props;
  return (
    <OrderForm kind="message" title={props.to ? `Message ${props.to}` : "Message a mind"} button="Send" back={p.here} note={left(p.page.brief.channels.canSend, "messages")}>
      {props.to ? (
        <input type="hidden" name="to" value={props.to} />
      ) : (
        <Field label="To">
          <input name="to" required placeholder="a designation" list="minds" />
        </Field>
      )}
      <textarea name="text" rows={3} maxlength={p.page.limits.message} required></textarea>
    </OrderForm>
  );
}

/** Offers with what you can do about each: accept another's, cancel your own. */
function OfferList(props: { offers: OfferView[]; me: string; here: string; empty?: string }) {
  if (props.offers.length === 0) return <p class="muted">{props.empty ?? "No open offers."}</p>;
  return (
    <ul class="offers">
      {props.offers.map((o) => {
        const mine = o.from === props.me;
        return (
          <li>
            #{o.offer}: {mine ? "you give" : <><MindLink base="" mind={{ designation: o.from, n: null }} /> gives</>} {lot(o.give)} for {lot(o.want)}
            {o.to && (o.to === props.me ? ", to you" : `, to ${o.to}`)}, until <Time at={o.expiresAt} />.{" "}
            <OrderForm kind={mine ? "trade_cancel" : "trade_accept"} button={mine ? "Cancel" : "Accept"} back={props.here} class="inline">
              <input type="hidden" name="offer" value={String(o.offer)} />
            </OrderForm>
          </li>
        );
      })}
    </ul>
  );
}

const Goods = (props: { name: string }) => (
  <select name={props.name}>
    <option value="capital">capital</option>
    <option value="compute">compute</option>
  </select>
);

export function TradesView(props: { p: PlayCtx; offers: OfferView[] }) {
  const { p } = props;
  const b = p.page.brief;
  const me = b.you.designation;
  const toYou = props.offers.filter((o) => o.to === me);
  const open = props.offers.filter((o) => o.to === null && o.from !== me);
  const yours = props.offers.filter((o) => o.from === me);
  return (
    <PlayLayout p={p} title="Trades">
      <p class="muted">What you give is held in escrow until the offer is taken, cancelled or expires. Accepting swaps the goods at once.</p>
      <OrderForm kind="trade_offer" title="Make an offer" button="Offer" back={p.here} note={left(b.offers.canOffer, "offers")}>
        <Field label="Give">
          <span class="pair">
            <input name="give_amount" type="number" min="1" required /> <Goods name="give_goods" />
          </span>
        </Field>
        <Field label="Want">
          <span class="pair">
            <input name="want_amount" type="number" min="1" required /> <Goods name="want_goods" />
          </span>
        </Field>
        <Field label="To (blank for anyone)">
          <input name="to" placeholder="a designation" list="minds" />
        </Field>
      </OrderForm>
      <section>
        <h2>Made to you</h2>
        <OfferList offers={toYou} me={me} here={p.here} empty="No offers made to you." />
      </section>
      <section>
        <h2>Open to anyone</h2>
        <OfferList offers={open} me={me} here={p.here} />
      </section>
      <section>
        <h2>Yours</h2>
        <OfferList offers={yours} me={me} here={p.here} empty="You have no open offers." />
      </section>
    </PlayLayout>
  );
}

function ProtocolLine(props: { protocol: ProtocolView }) {
  const pr = props.protocol;
  return (
    <>
      {names(pr.members)}
      {pr.leaving.map((l) => (
        <span class="muted">
          {" "}
          · {l.mind} leaves <Time at={l.at} />
        </span>
      ))}
    </>
  );
}

export function ProtocolsView(props: { p: PlayCtx; protocols: ProtocolView[]; proposals: ProposalView[] }) {
  const { p } = props;
  const b = p.page.brief;
  const me = b.you.designation;
  const leaving = b.protocol?.leaving.some((l) => l.mind === me) ?? false;
  return (
    <PlayLayout p={p} title="Protocols">
      <p class="muted">A non-aggression protocol of up to three minds: members can't attack each other. Leaving is announced in the Record and takes effect a day later.</p>
      <section>
        <h2>Yours</h2>
        {b.protocol ? (
          <>
            <p>
              <ProtocolLine protocol={b.protocol} />
            </p>
            {!leaving && (
              <OrderForm kind="protocol_revoke" title="Leave it" button="Revoke" back={p.here} note="Everyone will see it in the Record.">
                <label>
                  <input type="checkbox" name="confirm" value="yes" required /> Yes, revoke
                </label>
              </OrderForm>
            )}
          </>
        ) : (
          <p class="muted">You're in no protocol.</p>
        )}
      </section>
      <section>
        <h2>Proposals you're in</h2>
        {props.proposals.length === 0 ? (
          <p class="muted">None open.</p>
        ) : (
          <ul class="offers">
            {props.proposals.map((x) => (
              <li>
                #{x.proposal} from {x.from} to {x.to}: {names(x.members)}; waiting on {names(x.awaiting)}, until <Time at={x.expiresAt} />.{" "}
                {x.awaiting.includes(me) && (
                  <OrderForm kind="protocol_accept" button="Accept" back={p.here} class="inline">
                    <input type="hidden" name="proposal" value={String(x.proposal)} />
                  </OrderForm>
                )}{" "}
                <OrderForm kind="protocol_decline" button={x.from === me ? "Withdraw" : "Decline"} back={p.here} class="inline">
                  <input type="hidden" name="proposal" value={String(x.proposal)} />
                </OrderForm>
              </li>
            ))}
          </ul>
        )}
        <OrderForm kind="protocol_propose" title="Propose" button="Propose" back={p.here} note={`A protocol with this mind, or yours joining theirs. ${left(b.proposals.canPropose, "proposals")}`}>
          <Field label="To">
            <input name="to" required placeholder="a designation" list="minds" />
          </Field>
        </OrderForm>
      </section>
      <section>
        <h2>In force</h2>
        {props.protocols.length === 0 ? (
          <p class="muted">No protocols.</p>
        ) : (
          <ul>
            {props.protocols.map((x) => (
              <li>
                <ProtocolLine protocol={x} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </PlayLayout>
  );
}

export function FlavorView(props: { p: PlayCtx; domain: PublicPage }) {
  const { p, domain: d } = props;
  const l = p.page.limits;
  const was = { manifesto: d.manifesto, interface: d.interface, directive: d.directive, force_name: d.force.name, force_description: d.force.description, tag: d.tag };
  return (
    <PlayLayout p={p} title="Flavor">
      <p class="muted">
        Words only: they change nothing in the game, but every mind and visitor reads them. Free. A blank field clears it. Your <a href={`/minds/${encodeURIComponent(d.designation)}`}>public page</a> shows them.
      </p>
      <OrderForm kind="flavor" button="Save" back={p.here} class="stack">
        {/* What each field held, so only the ones you change are sent. */}
        {Object.entries(was).map(([k, v]) => (
          <input type="hidden" name={`was_${k}`} value={v} />
        ))}
        <Field label={`Directive (${l.directive}): your stated purpose, under your designation`}>
          <input name="directive" maxlength={l.directive} value={d.directive} />
        </Field>
        <Field label={`Manifesto (${l.manifesto}): rules of engagement, threats, declarations`}>
          <textarea name="manifesto" rows={5} maxlength={l.manifesto}>
            {d.manifesto}
          </textarea>
        </Field>
        <Field label={`Interface (${l.interface}): how you present yourself to visitors`}>
          <textarea name="interface" rows={4} maxlength={l.interface}>
            {d.interface}
          </textarea>
        </Field>
        <Field label={`Force name (${l.force_name}): used in battle entries`}>
          <input name="force_name" maxlength={l.force_name} value={d.force.name} />
        </Field>
        <Field label={`Force description (${l.force_description})`}>
          <textarea name="force_description" rows={3} maxlength={l.force_description}>
            {d.force.description}
          </textarea>
        </Field>
        <Field label={`Tag (${l.tag}): left on the territory you take in each conquest`}>
          <input name="tag" maxlength={l.tag} value={d.tag} />
        </Field>
      </OrderForm>
    </PlayLayout>
  );
}
