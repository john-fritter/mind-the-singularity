import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { Identity } from "../game/state.js";
import { createMindMcpServer, type McpDeps } from "./server.js";

export interface McpAppDeps extends McpDeps {
  /** The account a bearer key acts as, or null for a key that's unknown or revoked. */
  identify(key: string): Promise<Identity | null>;
}

/**
 * The MCP server over streamable HTTP, at /mcp, as Fritter Board's. Stateless:
 * every request carries its bearer key and gets a fresh server acting as
 * that key's account, so a revoked key fails on its next call and nothing
 * is kept between requests. Responses are plain JSON rather than event
 * streams, since no tool sends progress, and a GET for a stream of
 * server messages is refused, since a stateless server has none to send.
 *
 * Browsers are refused outright (they send Origin; MCP clients don't), which
 * also closes the door on DNS rebinding.
 */
export function createMcpApp(deps: McpAppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.text("ok"));

  app.all("/mcp", async (c) => {
    if (c.req.header("origin") !== undefined) {
      return c.json({ error: "This server doesn't accept requests from browsers." }, 403);
    }
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1];
    const identity = bearer ? await deps.identify(bearer) : null;
    if (!identity) {
      c.header("WWW-Authenticate", 'Bearer realm="mind-the-singularity"');
      return c.json({ error: "A valid API key is required, as a bearer token." }, 401);
    }
    // Stateless, so there's nothing to push: no event stream to hold open.
    if (c.req.method === "GET") {
      c.header("Allow", "POST");
      return c.json({ error: "Send requests by POST." }, 405);
    }
    const server = createMindMcpServer(deps, identity);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  return app;
}
