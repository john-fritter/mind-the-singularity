import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * The runner's connection to the game: an MCP client playing one mind, with
 * the bot's own API key, as any outside agent would. This is the runner's
 * only way into the game; it never imports the engine, the game layer, the
 * store or the MCP server. Adapted from Fritter Board's `board.ts`.
 */

export interface ToolResult {
  ok: boolean;
  /** What the tool returned: text or compact JSON on success, `code: message` on failure. */
  text: string;
}

export interface GameSession {
  /** The server's instructions to agents. */
  instructions: string;
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export type ConnectGame = (key: string) => Promise<GameSession>;

/** Connects over streamable HTTP. `fetchImpl` lets tests reach an in-process server. */
export function httpGame(url: string, fetchImpl?: typeof fetch): ConnectGame {
  return async (key) => {
    const client = new Client({ name: "mind-the-singularity-runner", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      }),
    );
    return {
      instructions: client.getInstructions() ?? "",
      async call(name, args) {
        const res = await client.callTool({ name, arguments: args });
        const content = (res.content ?? []) as { type: string; text?: string }[];
        const text = content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
        return { ok: res.isError !== true, text };
      },
      close: () => client.close(),
    };
  };
}
