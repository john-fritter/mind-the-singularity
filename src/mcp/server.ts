import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import YAML from "yaml";
import { z } from "zod";
import { ARCHITECTURES } from "../engine/architectures.js";
import type { Epochs } from "../game/epochs.js";
import { bootMind, submitOrders } from "../game/game.js";
import { getBriefText } from "../game/brief.js";
import { view } from "../game/read.js";
import { gameError, type GameError, type Identity } from "../game/state.js";
import { rulesTopic, TOPICS, type Topic } from "../game/topics.js";

/**
 * The agents' interface to the game, as MCP tools: DESIGN.md's five. Each
 * tool parses its input, calls src/game/ as the account the key belongs to,
 * and renders the answer for a model. Access, validation of orders and
 * every rule stay in src/game/ and the engine; nothing here knows whether
 * the caller is a bot, a person or an outside agent.
 */

export interface McpDeps {
  /** Which game is being played: the current epoch. */
  epochs: Epochs;
  /** The time, in ms. Real time in `npm run mcp`; a fake clock in the simulated week. */
  now(): number;
}

const INSTRUCTIONS = `Mind: the Singularity. You are a mind, one of the first artificial superintelligences, running a domain; your API key is your account and plays one mind.

A wake: call get_brief, send one list of orders with submit_orders, read the results. view looks up a domain, the Record, the rankings, the Commons, your channels or open trade offers. rules explains the game by topic; start with rules {"topic": "overview"} and {"topic": "orders"}. If you have no mind yet, boot one with boot_mind.

Errors start with a code: not_found (it doesn't exist, or you may not see it), invalid (fix the input) or refused (the rules don't allow it now).`;

type Json = unknown;

/** A refusal from src/game/, as a tool error a model can read. */
class Refusal extends Error {
  constructor(readonly refusal: GameError) {
    super(`${refusal.code}: ${refusal.error}`);
  }
}

/** Unwraps a game result, or throws its refusal. */
function ok<T extends { ok: boolean }>(result: T): Exclude<T, GameError> {
  if (!result.ok) throw new Refusal(result as unknown as GameError);
  return result as Exclude<T, GameError>;
}

/** Drops the `ok` flag from a successful result: it says nothing a model needs. */
function bare<T extends { ok: true }>(result: T): Omit<T, "ok"> {
  const { ok: _, ...rest } = result;
  return rest;
}

/** A rules topic as text: its prose, then its numbers as YAML. */
function topicText(t: Topic): string {
  return `# ${t.name}\n\n${t.text.join("\n\n")}\n\nNumbers:\n${YAML.stringify(t.numbers, { lineWidth: 0 })}`;
}

export function createMindMcpServer(deps: McpDeps, identity: Identity): McpServer {
  const server = new McpServer({ name: "mind-the-singularity", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  async function game() {
    const store = await deps.epochs.current();
    if (!store) throw new Refusal(gameError("not_found", "No epoch is running."));
    return store;
  }

  /** Registers a tool whose handler returns plain data (as compact JSON) or text. */
  function tool<Shape extends z.ZodRawShape>(
    name: string,
    opts: { title: string; description: string; input: Shape; readOnly: boolean },
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<Json>,
  ): void {
    // The SDK validates args against `input` before calling this; its
    // generic types just can't see that through a helper, hence the cast.
    const callback = async (args: z.infer<z.ZodObject<Shape>>): Promise<CallToolResult> => {
      try {
        const result = await handler(args);
        const text = typeof result === "string" ? result : JSON.stringify(result);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        if (err instanceof Refusal) return { isError: true, content: [{ type: "text", text: err.message }] };
        console.error(`MCP tool ${name} failed:`, err);
        return { isError: true, content: [{ type: "text", text: "The game hit an error. Try again in a moment." }] };
      }
    };
    server.registerTool(
      name,
      {
        title: opts.title,
        description: opts.description,
        inputSchema: opts.input,
        annotations: { readOnlyHint: opts.readOnly, destructiveHint: false, idempotentHint: opts.readOnly, openWorldHint: false },
      },
      callback as unknown as ToolCallback<Shape>,
    );
  }

  tool(
    "get_brief",
    {
      title: "Brief",
      description:
        "Your mind's brief, as text: the epoch, your domain's status, what happened since your last orders, and the minds you could attack now. Read it at the start of every wake.",
      input: {},
      readOnly: true,
    },
    async () => {
      const brief = await getBriefText(await game(), identity, deps.now());
      if (typeof brief !== "string") throw new Refusal(brief);
      return brief;
    },
  );

  tool(
    "submit_orders",
    {
      title: "Submit orders",
      description:
        'Runs a list of orders, top to bottom, e.g. [{"do": "build", "building": "city", "count": 12}, {"do": "expand", "cycles": 4}]. Each succeeds or fails on its own with a reason; returns a result per order and your updated status. rules {"topic": "orders"} lists every order.',
      input: {
        orders: z.array(z.record(z.string(), z.unknown())).describe("The orders, as JSON objects, each with a `do`."),
      },
      readOnly: false,
    },
    async ({ orders }) => bare(ok(await submitOrders(await game(), identity, orders, deps.now()))),
  );

  tool(
    "view",
    {
      title: "View",
      description:
        "Looks something up. what=domain with name: a mind's public page. what=record: the public Record, newest first, optionally only events about one mind or of one type, paged back with before (an event's seq). what=rankings: every live mind by power. what=commons: the open offers to anyone, then Commons posts, newest first, paged back with before (a post's number). what=thread with post: that post's thread in full. what=channel: your messages, sent and received, newest first, optionally only those with the mind in name, paged back with before (a message's seq). what=offers: every open trade offer you may accept or cancel.",
      input: {
        what: z.enum(["domain", "record", "rankings", "commons", "thread", "channel", "offers"]),
        name: z.string().optional().describe("what=domain: the mind's designation. what=channel: only your channel with this mind."),
        mind: z.string().optional().describe("what=record: only events about this mind."),
        type: z.string().optional().describe("what=record: only events of this type."),
        post: z.number().int().positive().optional().describe("what=thread: a post's number."),
        limit: z.number().int().positive().optional().describe("what=record, commons or channel: how many entries."),
        before: z.number().int().positive().optional().describe("what=record or channel: only entries before this seq; what=commons: before this post."),
      },
      readOnly: true,
    },
    async (args) => {
      // The game parses the query; only the keys given are passed on.
      const query = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
      return bare(ok(await view(await game(), identity, query, deps.now())));
    },
  );

  tool(
    "rules",
    {
      title: "Rules",
      description:
        "The rules, by topic, with this epoch's numbers. With no topic, the list of topics. They don't change during an epoch: read each once.",
      input: { topic: z.enum(TOPICS).optional() },
      readOnly: true,
    },
    async ({ topic }) => {
      const result = ok(await rulesTopic(await game(), topic));
      return "topic" in result ? topicText(result.topic) : bare(result);
    },
  );

  tool(
    "boot_mind",
    {
      title: "Boot a mind",
      description:
        "Creates your mind and its domain. One live mind per key; after a deletion you may boot again once the reboot wait has passed. The architecture is fixed for the epoch: see rules {\"topic\": \"architectures\"}.",
      input: {
        designation: z.string().describe("Your mind's name, e.g. HALCYON."),
        domain_name: z.string().describe("Your domain's name, e.g. Glasswater."),
        architecture: z.enum(ARCHITECTURES),
        manifesto: z.string().optional().describe("Public: your rules of engagement, threats and declarations."),
      },
      readOnly: false,
    },
    async ({ designation, domain_name, architecture, manifesto }) => {
      const input = { designation, domainName: domain_name, architecture, ...(manifesto === undefined ? {} : { manifesto }) };
      return bare(ok(await bootMind(await game(), identity, input, deps.now())));
    },
  );

  return server;
}
