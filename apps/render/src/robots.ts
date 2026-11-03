// robots.txt for the user agent token `x429-render` (RFC 9309): the groups for our token, else `*`;
// the longest matching rule wins, allow on a tie; `*` and `$` in paths. Cached per origin for 10
// minutes. A robots.txt that cannot be fetched (network error, 5xx, too big) allows: the brief's rule.
// 4xx means there is none, which allows too. The file is fetched through the SSRF guard.
import { BlockedError, type Guard } from "./guard.ts";

export type Rule = { allow: boolean; pattern: string };
export type Group = { agents: string[]; rules: Rule[] };

/** Parses robots.txt into groups (user-agent lines and the rules after them). */
export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      lastWasAgent = false;
      if (!current) continue; // rules before any user-agent line belong to nobody
      if (key === "disallow" && value === "") continue; // "Disallow:" with no path allows everything
      current.rules.push({ allow: key === "allow", pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

/** The rules that apply to `token`: every group naming it, else every `*` group. */
export function rulesFor(groups: Group[], token: string): Rule[] {
  const t = token.toLowerCase();
  const mine = groups.filter((g) => g.agents.some((a) => a === t || a.split("/")[0] === t));
  const pick = mine.length > 0 ? mine : groups.filter((g) => g.agents.includes("*"));
  return pick.flatMap((g) => g.rules);
}

function patternRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** Whether `path` (pathname + search) may be fetched under `rules`. */
export function allowedBy(rules: Rule[], path: string): boolean {
  if (path === "/robots.txt") return true;
  let best: Rule | undefined;
  for (const r of rules) {
    if (!patternRegex(r.pattern).test(path)) continue;
    const len = r.pattern.length;
    if (!best || len > best.pattern.length || (len === best.pattern.length && r.allow && !best.allow)) best = r;
  }
  return best ? best.allow : true;
}

export type RobotsOptions = {
  guard: Guard;
  token: string;
  userAgent: string;
  ttlMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => number;
  log?: (e: Record<string, unknown>) => void;
};

type Entry = { expires: number; rules: Rule[] | null };

export class Robots {
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Entry>>();
  private readonly o: Required<Omit<RobotsOptions, "log">> & { log?: RobotsOptions["log"] };
  fetches = 0;

  constructor(o: RobotsOptions) {
    this.o = { ttlMs: 600_000, timeoutMs: 5_000, maxBytes: 512 * 1024, now: Date.now, ...o };
  }

  /** True when robots.txt of `url`'s origin lets our token fetch it. */
  async allowed(raw: string | URL): Promise<boolean> {
    const url = typeof raw === "string" ? new URL(raw) : raw;
    const entry = await this.entry(url.origin);
    return entry.rules === null ? true : allowedBy(entry.rules, `${url.pathname}${url.search}`);
  }

  private async entry(origin: string): Promise<Entry> {
    const hit = this.cache.get(origin);
    if (hit && hit.expires > this.o.now()) return hit;
    const p = this.pending.get(origin);
    if (p) return p;
    const run = this.load(origin).then((e) => {
      this.cache.set(origin, e);
      if (this.cache.size > 10_000) this.cache.delete(this.cache.keys().next().value!);
      return e;
    });
    this.pending.set(origin, run);
    try {
      return await run;
    } finally {
      this.pending.delete(origin);
    }
  }

  private async load(origin: string): Promise<Entry> {
    const expires = this.o.now() + this.o.ttlMs;
    this.fetches++;
    try {
      const r = await this.o.guard.fetch(`${origin}/robots.txt`, {
        headers: { "user-agent": this.o.userAgent, accept: "text/plain, */*;q=0.5" },
        maxBytes: this.o.maxBytes,
        maxRedirects: 5,
        timeoutMs: this.o.timeoutMs,
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
      if (r.status >= 200 && r.status < 300) return { expires, rules: rulesFor(parseRobots(r.body.toString("utf8")), this.o.token) };
      return { expires, rules: null }; // 3xx left over, 4xx (none), 5xx (error): allow
    } catch (err) {
      if (!(err instanceof BlockedError)) this.o.log?.({ evt: "robots_error", origin: new URL(origin).host, error: String((err as Error)?.message ?? err).slice(0, 120) });
      return { expires, rules: null };
    }
  }
}
