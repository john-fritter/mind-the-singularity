import assert from "node:assert/strict";
import { loadRules } from "../src/config.js";
import { HOUR_MS } from "../src/engine/cycles.js";
import { bootMind, currentMind, newGame, submitOrders } from "../src/game/game.js";
import { briefText } from "../src/game/brief.js";
import { getBrief, view, type Brief } from "../src/game/read.js";
import { MemoryStore } from "../src/store/memory.js";
import { createApp } from "../src/app.js";
import { fixedEpoch } from "../src/game/epochs.js";
import { logIn, memoryLogins } from "./logins.js";

// Private stays private (CLAUDE.md): another mind's scratchpad, full status,
// private events, channels, offers made to one mind and protocol proposals never reach `view` or another mind's brief,
// and what can't be seen is "not found". Extend this for every new read.
// The web view is checked by crawling it as an anonymous visitor, so a page
// added later is checked without changing this file, and again logged in as
// a third mind, whose pages must show nothing of the others' secrets and
// whose public pages must be the anonymous visitor's but for the header.

const rules = loadRules();
const T0 = Date.UTC(2026, 9, 5, 12);
const T = T0 + 50 * HOUR_MS;
const SECRET = "SECRET-PLAN-7731";
/** A message between HALCYON and VESTA: PIKE and strangers never see it. */
const WHISPER = "WHISPER-4410";

/** The keys a public listing or page may carry, and nothing else. */
const SUMMARY_KEYS = ["architecture", "designation", "power", "rank", "status", "territory"];
// Flavor is public by design (DESIGN.md: "Flavor text and the Record"); the scratchpad is not.
const PAGE_KEYS = [...SUMMARY_KEYS, "bootedAt", "domainName", "manifesto", "interface", "directive", "force", "tag", "tagsLeft", "lastLog", "protocol"].sort();

async function main() {
  const game = newGame(rules, { epoch: 1, seed: 11, startedAt: T0 });
  const store = new MemoryStore(game);
  const halcyon = { account: "halcyon" };
  const vesta = { account: "vesta" };
  const pike = { account: "pike" };
  assert.ok((await bootMind(store, halcyon, { designation: "HALCYON", domainName: "Glasswater", architecture: "oracle" }, T0)).ok);
  assert.ok((await bootMind(store, vesta, { designation: "VESTA", domainName: "Hearth", architecture: "steward" }, T0)).ok);
  assert.ok((await bootMind(store, pike, { designation: "PIKE", domainName: "Narrows", architecture: "accelerant" }, T0)).ok);
  // HALCYON knows Probe from the start, so it can look at VESTA.
  currentMind(game, "halcyon")!.known = ["probe"];

  const out = await submitOrders(
    store,
    halcyon,
    [
      { do: "scratchpad", text: SECRET },
      { do: "message", to: "VESTA", text: WHISPER },
      { do: "post", text: "A public word." },
      // An offer to VESTA alone: PIKE and strangers never see it.
      { do: "trade_offer", give: { capital: 777 }, want: { compute: 1 }, to: "VESTA" },
      // A protocol proposal to VESTA: only the two of them know of it.
      { do: "protocol_propose", to: "VESTA" },
      // Programs can crash; one of three probes gets through.
      { do: "execute", program: "probe", target: "VESTA" },
      { do: "execute", program: "probe", target: "VESTA" },
      { do: "execute", program: "probe", target: "VESTA" },
      { do: "attack", target: "VESTA", mode: "raid" },
    ],
    T,
  );
  assert.ok(out.ok);
  assert.ok(out.results.some((r) => r.ok && r.status), "the prober sees VESTA's full status");
  assert.ok(game.record.some((e) => e.type === "probed") && game.record.some((e) => e.type === "battle_report"));

  // VESTA's brief: the raid, but not the probe, and nothing of HALCYON's own.
  const theirs = (await getBrief(store, vesta, T)) as Brief;
  const text = JSON.stringify(theirs);
  assert.ok(!text.includes(SECRET), "a scratchpad leaked into another mind's brief");
  const seen = [...theirs.since.yours, ...theirs.since.world, ...theirs.since.fights];
  assert.ok(!seen.some((e) => e.type === "probed"), "the target was told of a probe");
  assert.ok(theirs.since.yours.some((e) => e.type === "battle_report"), "the defender gets its battle report");
  assert.ok(seen.every((e) => e.public || e.domains.includes(currentMind(game, "vesta")!.id)));
  assert.ok(theirs.since.world.every((e) => e.public) && theirs.since.fights.every((e) => e.public));
  const theirText = briefText(rules, theirs);
  assert.ok(!theirText.includes(SECRET) && !theirText.includes("Probed"), "the brief's text leaked something private");
  for (const d of theirs.inRange) assert.deepEqual(Object.keys(d).sort(), SUMMARY_KEYS);

  // VESTA reads the message; PIKE, a third mind, sees nothing of it anywhere.
  assert.ok(theirs.channels.messages.some((m) => m.text === WHISPER));
  const pikes = (await getBrief(store, pike, T)) as Brief;
  assert.equal(pikes.channels.messages.length, 0);
  assert.ok(!JSON.stringify(pikes).includes(WHISPER) && !briefText(rules, pikes).includes(WHISPER), "a message leaked into a third mind's brief");
  assert.ok(pikes.commons.posts.some((p) => p.text === "A public word."), "the Commons is public");
  for (const query of [{ what: "channel" }, { what: "channel", name: "HALCYON" }, { what: "channel", name: "VESTA" }]) {
    const channel = await view(store, pike, query, T);
    assert.ok(channel.ok && channel.what === "channel" && channel.messages.length === 0, `PIKE sees ${JSON.stringify(channel)}`);
  }

  // The offer to VESTA: VESTA and HALCYON see it, PIKE and strangers don't, and PIKE can't take it.
  assert.deepEqual(theirs.offers.toYou.map((o) => o.offer), [1]);
  assert.deepEqual(pikes.offers.toYou.concat(pikes.offers.open, pikes.offers.yours), []);
  assert.doesNotMatch(briefText(rules, pikes), /777|OPEN OFFERS/);
  for (const who of [pike, { account: "stranger" }]) {
    const offers = await view(store, who, { what: "offers" }, T);
    assert.ok(offers.ok && offers.what === "offers" && offers.offers.length === 0, `${who.account} sees ${JSON.stringify(offers)}`);
    const commons = await view(store, who, { what: "commons" }, T);
    assert.ok(commons.ok && commons.what === "commons" && commons.offers.length === 0);
  }
  const taken = await submitOrders(store, pike, [{ do: "trade_accept", offer: 1 }, { do: "trade_accept", offer: 2 }], T);
  assert.ok(taken.ok && taken.results.every((r) => !r.ok) && taken.results[0]!.message === taken.results[1]!.message.replace("2", "1"), "hidden is missing");

  // The proposal to VESTA: VESTA sees it, PIKE and strangers don't, and PIKE can't answer it.
  assert.deepEqual(theirs.proposals.toYou.map((p) => p.proposal), [1]);
  assert.deepEqual(pikes.proposals, { toYou: [], left: 0, yours: null, canPropose: rules.social.protocol_proposals_per_day });
  assert.doesNotMatch(briefText(rules, pikes), /PROTOCOL PROPOSALS/);
  for (const who of [pike, { account: "stranger" }]) {
    const protocols = await view(store, who, { what: "protocols" }, T);
    assert.ok(protocols.ok && protocols.what === "protocols" && protocols.proposals.length === 0, `${who.account} sees ${JSON.stringify(protocols)}`);
  }
  const answered = await submitOrders(store, pike, [{ do: "protocol_decline", proposal: 1 }, { do: "protocol_decline", proposal: 2 }], T);
  assert.ok(answered.ok && answered.results.every((r) => !r.ok) && answered.results[0]!.message === answered.results[1]!.message.replace("2", "1"), "hidden is missing");
  // Withdrawn, it closes privately.
  assert.ok((await submitOrders(store, halcyon, [{ do: "protocol_decline", proposal: 1 }], T)).ok);

  // HALCYON's own brief shows what's its own.
  const mine = (await getBrief(store, halcyon, T)) as Brief;
  assert.equal(mine.you.scratchpad, SECRET);

  // The public views: nothing private, from anyone's seat.
  for (const who of [halcyon, vesta, pike, { account: "stranger" }]) {
    const page = await view(store, who, { what: "domain", name: "HALCYON" }, T);
    assert.ok(page.ok && page.what === "domain");
    assert.deepEqual(Object.keys(page.domain).sort(), PAGE_KEYS);
    const ranks = await view(store, who, { what: "rankings" }, T);
    assert.ok(ranks.ok && ranks.what === "rankings");
    for (const d of ranks.domains) assert.deepEqual(Object.keys(d).sort(), SUMMARY_KEYS);
    for (const query of [
      { what: "record" },
      { what: "record", mind: "VESTA" },
      { what: "record", type: "probed" },
      { what: "record", type: "battle_report" },
      { what: "record", type: "message" },
      { what: "record", type: "offers_withdrawn" },
      { what: "record", type: "offer_expired" },
      { what: "record", type: "storage_full" },
      { what: "record", type: "proposal_closed" },
    ]) {
      const record = await view(store, who, query, T);
      assert.ok(record.ok && record.what === "record");
      assert.ok(record.entries.every((e) => e.public), `a private event in ${JSON.stringify(query)}`);
      const shown = JSON.stringify(record);
      assert.ok(!shown.includes(SECRET) && !shown.includes("Strength") && !shown.includes(WHISPER), "private detail in the Record");
    }
    for (const query of [{ what: "commons" }, { what: "thread", post: 1 }]) {
      const shown = JSON.stringify(await view(store, who, query, T));
      assert.ok(shown.includes("A public word.") && !shown.includes(WHISPER) && !shown.includes(SECRET), `private detail in ${JSON.stringify(query)}`);
    }
    // Hidden is the same as missing.
    const missing = await view(store, who, { what: "domain", name: "NOBODY" }, T);
    assert.ok(!missing.ok && missing.code === "not_found");
  }
  const stranger = await getBrief(store, { account: "stranger" }, T);
  assert.ok("ok" in stranger && stranger.code === "not_found");
  // Without a mind there are no channels: not found, as anything hidden is.
  const noChannel = await view(store, { account: "stranger" }, { what: "channel", name: "VESTA" }, T);
  assert.ok(!noChannel.ok && noChannel.code === "not_found");

  await anonymousVisitor(store);
}

/** Text only a mind and those it chose may see, and full status no one else may. None may appear on a public page. */
const STATUS_CAPITAL = 9876543;
const STATUS_COMPUTE = 1234567;

/**
 * An anonymous visitor to the web view: crawls every page reachable from the
 * front page, plus the Record filtered by every event type and some guessed
 * addresses, and finds nothing private anywhere.
 */
async function anonymousVisitor(store: MemoryStore) {
  const game = await store.read();
  // An open proposal and full status worth hiding, as the crawl starts.
  const proposed = await submitOrders(store, { account: "halcyon" }, [{ do: "protocol_propose", to: "VESTA" }], T);
  assert.ok(proposed.ok && proposed.results[0]!.ok);
  const halcyon = currentMind(game, "halcyon")!;
  halcyon.capital = STATUS_CAPITAL;
  halcyon.compute = STATUS_COMPUTE;
  assert.ok(game.world.offers.some((o) => o.to !== null), "a private offer is open");

  const logins = memoryLogins({ pike: "pike-password", halcyon: "halcyon-password" });
  const app = createApp({ epochs: fixedEpoch(store), now: () => T, identify: async () => null, logins });
  /** What only HALCYON, VESTA or a prober may know. */
  const SECRETS = [
    SECRET,
    WHISPER,
    "Probed",
    "Strength",
    "777 capital",
    String(STATUS_CAPITAL),
    STATUS_CAPITAL.toLocaleString("en-US"),
    String(STATUS_COMPUTE),
    STATUS_COMPUTE.toLocaleString("en-US"),
  ];
  // Words no public page has cause to say; the rules text explains them, so it may.
  const WORDS = ["proposal", "scratchpad"];
  const pages = new Map<string, number>();

  async function visit(url: string): Promise<{ status: number; body: string }> {
    const res = await app.request(url);
    const body = await res.text();
    pages.set(url, res.status);
    for (const leak of SECRETS) assert.ok(!body.includes(leak), `${url} shows "${leak}"`);
    if (!url.startsWith("/rules")) for (const word of WORDS) assert.ok(!body.includes(word), `${url} shows "${word}"`);
    if (res.headers.get("content-type")?.startsWith("text/html")) {
      assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/, `${url} has no CSP`);
      assert.doesNotMatch(body, /<script|\sstyle=|\son[a-z]+=/i, `${url} has a script or inline style`);
    }
    return { status: res.status, body };
  }

  // Every same-site link, breadth first, from the front page and every Record filter.
  const queue = ["/"];
  const types = [...new Set([...game.record.map((e) => e.type), "probed", "message", "battle_report", "proposal_closed", "offers_withdrawn"])];
  for (const type of types) queue.push(`/record?type=${type}`);
  while (queue.length > 0 && pages.size < 500) {
    const url = queue.shift()!;
    if (pages.has(url)) continue;
    const { status, body } = await visit(url);
    assert.ok([200, 303, 400, 404].includes(status), `${url} answered ${status}`);
    for (const m of body.matchAll(/href="([^"]+)"/g)) {
      const href = m[1]!.replace(/&amp;/g, "&");
      if (href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/static/") && !pages.has(href)) queue.push(href);
    }
  }
  for (const must of ["/", "/rankings", "/record", "/commons", "/archive", "/minds/HALCYON", "/minds/VESTA", "/minds/PIKE", "/commons/1", "/login", "/rules", "/rules/orders"]) {
    assert.equal(pages.get(must), 200, `the crawl didn't reach ${must}`);
  }
  // Private event types aren't a filter: refused, and nothing shown.
  for (const type of ["probed", "message", "battle_report", "proposal_closed", "offers_withdrawn"]) {
    assert.equal(pages.get(`/record?type=${type}`), 400, `/record?type=${type}`);
  }

  // What's private has no address: hidden is the same as missing.
  for (const url of [
    "/channels",
    "/channel/VESTA",
    "/minds/VESTA/channel",
    "/minds/HALCYON/status",
    "/minds/HALCYON/scratchpad",
    "/scratchpad",
    "/offers",
    "/proposals",
    "/protocols/proposals",
    "/brief",
    "/minds/NOBODY",
    "/commons/99",
    "/archive/1",
  ]) {
    assert.equal((await visit(url)).status, 404, `${url} isn't 404`);
  }
  // The play pages send a visitor to log in, and show nothing first.
  for (const url of ["/play", "/settings"]) {
    const res = await app.request(url);
    assert.equal(res.status, 303, `${url} for a visitor`);
    assert.equal(res.headers.get("location"), "/login");
  }

  await loggedIn(app, logins, pages);
}

/**
 * PIKE, logged in, crawls the site: its own dashboard, every page it links
 * to and every page the visitor saw. None shows another mind's secrets, and
 * a public page reads exactly as it did for the visitor, but for the
 * masthead's account links.
 */
async function loggedIn(app: ReturnType<typeof createApp>, logins: ReturnType<typeof memoryLogins>, anonymous: Map<string, number>) {
  const cookie = await logIn(app, "pike", "pike-password");
  const SECRETS = [SECRET, WHISPER, "Probed", "Strength", "777 capital", String(STATUS_CAPITAL), STATUS_CAPITAL.toLocaleString("en-US"), String(STATUS_COMPUTE), STATUS_COMPUTE.toLocaleString("en-US")];
  const withoutAccount = (body: string) => body.replace(/<nav class="account"[\s\S]*?<\/nav>/, "");
  const seen = new Set<string>();
  const queue = ["/play", "/settings", ...anonymous.keys()];
  while (queue.length > 0 && seen.size < 600) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const res = await app.request(url, { headers: { cookie } });
    const body = await res.text();
    assert.ok([200, 303, 400, 404].includes(res.status), `${url} answered PIKE ${res.status}`);
    for (const leak of SECRETS) assert.ok(!body.includes(leak), `${url}, logged in as PIKE, shows "${leak}"`);
    if (res.headers.get("content-type")?.startsWith("text/html")) {
      assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/, `${url} has no CSP`);
      assert.doesNotMatch(body, /<script|\sstyle=|\son[a-z]+=/i, `${url} has a script or inline style`);
      assert.equal(res.headers.get("cache-control"), "no-store", `${url} may be cached though it was shown to PIKE`);
    }
    // The public pages; /login sends someone logged in on to /play.
    if (anonymous.has(url) && url !== "/login") {
      const visitor = await app.request(url);
      assert.equal(res.status, visitor.status, `${url} answers PIKE differently`);
      assert.equal(withoutAccount(body), withoutAccount(await visitor.text()), `${url} reads differently for PIKE`);
    }
    for (const m of body.matchAll(/href="([^"]+)"/g)) {
      const href = m[1]!.replace(/&amp;/g, "&");
      if (href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/static/") && !seen.has(href)) queue.push(href);
    }
  }
  assert.ok(seen.has("/play") && logins.sessions.size === 1);
  // PIKE's dashboard is its own: its designation, not HALCYON's scratchpad.
  const play = await (await app.request("/play", { headers: { cookie } })).text();
  assert.match(play, /PIKE/);
  assert.ok(!play.includes(SECRET));
}

main().then(
  () => console.log("privacy: all tests passed"),
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
