// Calls the bundled PayBox plugin (plugin/dist/plugin.mjs) over stdio the way the PayBox sandbox does:
// a fresh process per operation, one newline-delimited JSON-RPC request with MCP 2026-07-28 metadata,
// one response. Nothing survives between calls.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2026-07-28";

export type ToolResult = { content: { type: string; text: string }[]; structuredContent?: any; isError?: boolean };

export class PluginClient {
  readonly bundle: string;
  readonly node: string;
  readonly env: Record<string, string>;
  calls = 0;

  constructor(bundle: string, env: Record<string, string>, node = "node") {
    this.bundle = bundle;
    this.env = env;
    this.node = node;
  }

  /** One operation in a fresh process (10 s budget, like the hosted sandbox). */
  async request(method: string, params: Record<string, unknown>): Promise<any> {
    this.calls++;
    const child = spawn(this.node, [this.bundle], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "production", NO_COLOR: "1", ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += String(c)));
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
              "io.modelcontextprotocol/clientInfo": { name: "x429-e2e", version: "1" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        })}\n`,
      );
      for await (const line of lines) {
        const msg = JSON.parse(line);
        if (msg.id !== 1) continue;
        if (msg.error) throw new Error(`${method}: JSON-RPC error ${JSON.stringify(msg.error)}`);
        if (msg.result?.resultType !== "complete") throw new Error(`${method}: resultType ${msg.result?.resultType}`);
        return msg.result;
      }
      throw new Error(`${method}: plugin exited without a response (${stderr.slice(0, 300)})`);
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  }

  async listTools(): Promise<any[]> {
    return (await this.request("tools/list", {})).tools;
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.request("tools/call", { name, arguments: args });
  }
}
