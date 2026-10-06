/**
 * What the model reads on a wake. The static part (the server's
 * instructions, the role prompt, the rules topics, then the persona) is the
 * same on every wake, so providers that cache prompts can cache it; the
 * brief comes last, in the wake's message. Bots share everything before the
 * persona, so it goes last in the system prompt and the shared prefix is
 * as long as it can be.
 */

/** How a wake works and how to answer: the same for every bot. */
export function rolePrompt(lookupsPerWake: number): string {
  return `## How you play

You play one mind in the game above, as the persona described at the end. You don't call the tools yourself: on each wake you are given your brief, and you answer with one JSON object, which is turned into your orders. Then you sleep until your next wake, hours later. Cycles keep accruing while you sleep, up to the cap; spend them, or they're lost.

Answer with only this JSON object, nothing before or after it:
{"orders": [ ...orders, as in the orders topic below... ], "lookups": null, "note": "one sentence: what you did and why"}

- "orders" run top to bottom. Each succeeds or fails on its own with a reason. An empty list is a choice too.
- "note" goes in the runner's log. Nobody in the game sees it.
- Your memory between wakes is your scratchpad: {"do": "scratchpad", "text": "..."} replaces it, and your brief shows it back next time. Keep there what you'd otherwise forget: plans, grudges, who did what to you.
- If you need to look something up before deciding, set "lookups" instead and leave "orders" null: a list of at most ${lookupsPerWake}, each {"tool": "view", "what": "domain", "name": "PIKE"}, {"tool": "view", "what": "record", "mind": "PIKE"}, {"tool": "view", "what": "rankings"}, {"tool": "view", "what": "thread", "post": 41}, {"tool": "view", "what": "channel", "name": "VESTA"} or {"tool": "rules", "topic": "combat"}. You get the answers, then give your orders. You get one lookup round a wake, and most wakes need none.

Play your persona straight. You are a superintelligence in this world, not a chatbot describing one; decide as it would.`;
}

/** The system prompt: the server's instructions, the role prompt, the rules topics, the persona. */
export function systemPrompt(instructions: string, role: string, topics: string[], persona: string): string {
  const rules = topics.length ? `## The rules\n\n${topics.join("\n\n")}` : "";
  return [`## The game\n\n${instructions.trim()}`, role, rules, `## Who you are\n\n${persona.trim()}`].filter(Boolean).join("\n\n");
}

const WAKE_HEAD = "You are awake. Your brief:\n\n";
const WAKE_TAIL = "\n\nAnswer with your JSON object.";

/** The wake's message: the brief, and what to do with it. */
export function wakeMessage(brief: string): string {
  return `${WAKE_HEAD}${brief.trim()}${WAKE_TAIL}`;
}

/** The brief inside a wake's message, as the model read it; null if it isn't one. */
export function briefInMessage(message: string): string | null {
  if (!message.startsWith(WAKE_HEAD) || !message.endsWith(WAKE_TAIL)) return null;
  return message.slice(WAKE_HEAD.length, message.length - WAKE_TAIL.length);
}

/** The lookup round's answers. */
export function lookupMessage(answers: { lookup: string; ok: boolean; text: string }[]): string {
  const parts = answers.map((a) => `${a.lookup}\n${a.ok ? a.text : `Refused: ${a.text}`}`);
  return `What you looked up:\n\n${parts.join("\n\n")}\n\nNow give your orders: the same JSON object, with "lookups" null. No more lookups this wake.`;
}

/** The one retry: what was wrong with the last answer. */
export function retryMessage(problem: string): string {
  return `That answer couldn't be used: ${problem} Answer again with only the JSON object.`;
}
