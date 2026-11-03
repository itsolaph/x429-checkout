// The SSRF guard: which URLs the renderer may fetch, and the only HTTP client that fetches them.
//
// A target must be http or https on port 80 or 443, and every address its host resolves to must be
// public: no loopback, RFC 1918, CGNAT, link-local (cloud metadata lives there), ULA, multicast,
// documentation or reserved space, and no IPv6 forms that embed an IPv4 address. The client connects
// to the address it checked (the DNS answer is pinned for the connection), so a name that resolves to
// a public address for the check and to 127.0.0.1 for the connect cannot get through. Redirects are
// followed hop by hop, each hop checked again.
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import type { LookupFunction } from "node:net";

// separate lists: a BlockList also matches IPv4 addresses against IPv6 rules (as ::ffff:a.b.c.d)
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT (also Alibaba's metadata 100.100.100.200)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) blocked4.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::", 96], // IPv4-compatible (deprecated)
  ["::ffff:0:0", 96], // IPv4-mapped
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local NAT64
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments (Teredo, ORCHID, ...)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (embeds an IPv4 address)
  ["3fff::", 20], // documentation
  ["5f00::", 16], // segment routing
  ["fc00::", 7], // ULA (AWS metadata fd00:ec2::254)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) blocked6.addSubnet(net, prefix, "ipv6");

/** True when `ip` is a public unicast address the renderer may connect to. */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 0) return false;
  return v === 4 ? !blocked4.check(ip, "ipv4") : !blocked6.check(ip, "ipv6");
}

export class BlockedError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "BlockedError";
    this.reason = reason;
  }
}

export class BudgetError extends Error {
  constructor(message = "the response budget is used up") {
    super(message);
    this.name = "BudgetError";
  }
}

export type Address = { address: string; family: 4 | 6 };
export type Resolver = (host: string) => Promise<Address[]>;

/** Test seam: where to actually connect for a checked public address (never set in production). */
export type ConnectOverride = (checked: { address: string; port: number }) => { host: string; port: number } | undefined;

export type GuardOptions = {
  resolve?: Resolver;
  connect?: ConnectOverride;
};

export type Checked = { url: URL; host: string; port: number; address: string; family: 4 | 6 };

/** A byte budget shared by every fetch of one render: bytes are charged as they arrive. */
export type Budget = { used: number; max: number };

export type FetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | null;
  signal?: AbortSignal;
  /** Most decoded body bytes to accept; more throws BudgetError. */
  maxBytes: number;
  /** Shared with concurrent fetches: past `max`, this fetch stops with BudgetError (nothing over it is charged). */
  budget?: Budget;
  /** Redirect hops to follow (each checked again); a further 3xx is returned as it is. */
  maxRedirects?: number;
  timeoutMs?: number;
};

export type FetchResult = { url: string; status: number; headers: Record<string, string>; body: Buffer; redirects: number };

const systemResolve: Resolver = async (host) => (await dnsLookup(host, { all: true, verbatim: true })) as Address[];

const HOP = new Set(["host", "connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "accept-encoding", "expect"]);

export class Guard {
  private readonly resolve: Resolver;
  private readonly connect: ConnectOverride | undefined;

  constructor(opts: GuardOptions = {}) {
    this.resolve = opts.resolve ?? systemResolve;
    this.connect = opts.connect;
  }

  /** Parses and checks a URL without fetching it. Throws BlockedError. */
  policy(raw: string | URL): URL {
    let url: URL;
    try {
      url = typeof raw === "string" ? new URL(raw) : raw;
    } catch {
      throw new BlockedError("invalid_url", "not a valid absolute URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedError("scheme", "only http and https URLs");
    if (url.port !== "" && url.port !== "80" && url.port !== "443") throw new BlockedError("port", "only ports 80 and 443");
    if (url.username || url.password) throw new BlockedError("credentials", "URLs with credentials are refused");
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "" ) throw new BlockedError("invalid_url", "the URL has no host");
    if (host === "localhost" || host.endsWith(".localhost")) throw new BlockedError("private_address", "localhost is refused");
    if (isIP(host) && !isPublicAddress(host)) throw new BlockedError("private_address", `${host} is not a public address`);
    return url;
  }

  /** Checks a URL and resolves its host: every address must be public. Throws BlockedError. */
  async check(raw: string | URL): Promise<Checked> {
    const url = this.policy(raw);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    let addrs: Address[];
    const literal = isIP(host);
    if (literal) addrs = [{ address: host, family: literal as 4 | 6 }];
    else {
      try {
        addrs = await this.resolve(host);
      } catch {
        throw new BlockedError("dns", `${host} does not resolve`);
      }
    }
    if (addrs.length === 0) throw new BlockedError("dns", `${host} does not resolve`);
    // one private answer is enough to refuse: a name that also points inside is not fetched at all
    const bad = addrs.find((a) => !isPublicAddress(a.address));
    if (bad) throw new BlockedError("private_address", `${host} resolves to ${bad.address}, which is not a public address`);
    const first = addrs[0]!;
    return { url, host, port, address: first.address, family: first.family };
  }

  /** Fetches `raw` through the guard, following up to `maxRedirects` checked hops. */
  async fetch(raw: string, opts: FetchOptions): Promise<FetchResult> {
    let url = raw;
    let method = (opts.method ?? "GET").toUpperCase();
    let body = opts.body ?? null;
    const max = opts.maxRedirects ?? 0;
    for (let hop = 0; ; hop++) {
      const r = await this.once(url, { ...opts, method, body });
      const loc = r.headers.location;
      if (r.status >= 300 && r.status < 400 && r.status !== 304 && loc && hop < max) {
        url = new URL(loc, url).href;
        if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === "POST")) {
          method = "GET";
          body = null;
        }
        continue;
      }
      return { ...r, redirects: hop };
    }
  }

  private async once(raw: string, opts: FetchOptions): Promise<Omit<FetchResult, "redirects">> {
    const c = await this.check(raw);
    const isHttps = c.url.protocol === "https:";
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      const name = k.toLowerCase();
      if (name.startsWith(":") || HOP.has(name)) continue;
      headers[name] = v;
    }
    headers.host = c.url.host;
    headers["accept-encoding"] = "gzip, deflate, br";
    if (opts.body && opts.body.length > 0) headers["content-length"] = String(opts.body.length);
    const override = this.connect?.({ address: c.address, port: c.port });
    // the connection goes to the address that was checked, whatever the name resolves to by now
    const pinned: LookupFunction = (_host, options, cb) => {
      if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: Address[]) => void)(null, [{ address: c.address, family: c.family }]);
      else cb(null, c.address, c.family);
    };
    const reqOpts: http.RequestOptions & { servername?: string } = {
      method: opts.method ?? "GET",
      path: `${c.url.pathname}${c.url.search}`,
      headers,
      agent: false,
      signal: opts.signal,
      ...(override ? { host: override.host, port: override.port } : { host: c.host, port: c.port, lookup: pinned }),
      ...(isHttps && !override ? { servername: isIP(c.host) ? undefined : c.host } : {}),
    };
    const mod = isHttps && !override ? https : http;
    return new Promise((resolve, reject) => {
      const req = mod.request(reqOpts, (res) => {
        const status = res.statusCode ?? 502;
        const declared = Number(res.headers["content-length"] ?? -1);
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
        const decode = enc === "gzip" || enc === "x-gzip" ? zlib.createGunzip() : enc === "deflate" ? zlib.createInflate() : enc === "br" ? zlib.createBrotliDecompress() : undefined;
        const room = Math.min(opts.maxBytes, opts.budget ? opts.budget.max - opts.budget.used : Infinity);
        if (!decode && declared > room) {
          res.destroy();
          return reject(new BudgetError());
        }
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined || k === "content-length" || k === "transfer-encoding" || k === "connection" || k === "keep-alive" || k === "alt-svc") continue;
          if (k === "content-encoding" && decode) continue;
          out[k] = Array.isArray(v) ? v.join("\n") : v;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const stream = decode ? res.pipe(decode) : res;
        const b = opts.budget;
        stream.on("data", (chunk: Buffer) => {
          if (size + chunk.length > opts.maxBytes || (b && b.used + chunk.length > b.max)) {
            if (b) b.used = Math.max(b.used, Math.min(b.max, b.used + chunk.length)); // spent: later fetches stop at once
            res.destroy();
            decode?.destroy();
            return reject(new BudgetError());
          }
          size += chunk.length;
          if (b) b.used += chunk.length;
          chunks.push(chunk);
        });
        stream.on("end", () => resolve({ url: c.url.href, status, headers: out, body: Buffer.concat(chunks) }));
        stream.on("error", reject);
        res.on("error", reject);
      });
      if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(new Error("request timed out")));
      req.on("error", reject);
      req.end(opts.body && opts.body.length > 0 ? opts.body : undefined);
    });
  }
}
