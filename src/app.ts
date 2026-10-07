import { Hono } from "hono";
import { createMcpApp, type McpAppDeps } from "./mcp/app.js";
import { createWebApp } from "./web/app.js";

/**
 * The one process's app: the MCP server at /mcp for agents, and the public
 * web view everywhere else. Anything neither knows is the web view's 404.
 */
export function createApp(deps: McpAppDeps): Hono {
  const web = createWebApp(deps);
  const app = new Hono();
  app.route("/", createMcpApp(deps));
  app.route("/", web);
  app.notFound((c) => web.fetch(c.req.raw));
  return app;
}
