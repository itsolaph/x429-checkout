// Test fixtures: a local site server, and a Guard whose resolver maps test names to addresses.
//
//   site.test, other.test  → 93.184.215.14 / .15 (public documentation-free addresses); the guard's test
//                            connect hook sends those two to the local fixture server
//   rebind.test            → 127.0.0.1   (a public-looking name that resolves to loopback)
//   meta.test              → 169.254.169.254 (cloud metadata)
//   mixed.test             → 93.184.215.16 and 10.0.0.5
// Every request the fixture server receives is recorded, so a test can prove a private target was
// never reached.
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { Guard, type Address } from "../src/guard.ts";

export const SITE_IP = "93.184.215.14";
export const OTHER_IP = "93.184.215.15";

export const CHROMIUM = process.env.RENDER_CHROMIUM_PATH || join(homedir(), ".cache/ms-playwright/chromium-1248/chrome-linux64/chrome");
export const chromiumSkip = existsSync(CHROMIUM) ? undefined : `no Chromium at ${CHROMIUM} (set RENDER_CHROMIUM_PATH)`;

const NAMES: Record<string, Address[]> = {
  "site.test": [{ address: SITE_IP, family: 4 }],
  "other.test": [{ address: OTHER_IP, family: 4 }],
  "rebind.test": [{ address: "127.0.0.1", family: 4 }],
  "meta.test": [{ address: "169.254.169.254", family: 4 }],
  "mixed.test": [{ address: "93.184.215.16", family: 4 }, { address: "10.0.0.5", family: 4 }],
  "v6.test": [{ address: "fd00:ec2::254", family: 6 }],
};

export type Hit = { host: string; path: string; method: string; ua: string; cookie: string };

export type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export type Fixture = { port: number; hits: Hit[]; routes: Map<string, Handler>; server: Server; close(): Promise<void> };

/** A local site: `routes` maps "host/path" or "/path" to a handler; unknown paths are 404. */
export async function startFixture(): Promise<Fixture> {
  const hits: Hit[] = [];
  const routes = new Map<string, Handler>();
  const server = createServer((req, res) => {
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
    const path = (req.url ?? "/").split("?")[0]!;
    hits.push({ host, path, method: req.method ?? "GET", ua: String(req.headers["user-agent"] ?? ""), cookie: String(req.headers.cookie ?? "") });
    const h = routes.get(`${host}${path}`) ?? routes.get(path);
    if (!h) {
      res.writeHead(404, { "content-type": "text/plain" });
      return void res.end("not found");
    }
    void Promise.resolve(h(req, res)).catch(() => res.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    hits,
    routes,
    server,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** A guard for tests: test names resolve as above; site.test and other.test connect to the fixture. */
export function testGuard(fixturePort?: number): Guard {
  return new Guard({
    resolve: async (host) => {
      const a = NAMES[host];
      if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      return a;
    },
    connect: ({ address }) => (fixturePort && (address === SITE_IP || address === OTHER_IP) ? { host: "127.0.0.1", port: fixturePort } : undefined),
  });
}

export const html = (body: string, head = "") => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`);
};

export const redirect = (to: string, status = 302) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, { location: to });
  res.end();
};
