// The renderer: one long-lived Chromium, a fresh context per render (no cookies or storage carried
// over, JS on, downloads off, service workers blocked, 1280x800).
//
// Chromium never touches the network itself. Every request it makes goes through
// `context.route('**')` and is fetched in Node by the SSRF guard (DNS pinned to the checked address),
// then handed back with `route.fulfill`. Chromium is launched with a dead proxy, so anything route does
// not see (a preconnect, a WebSocket) fails instead of leaving the box, and WebSockets are closed.
//
// Redirects: Chromium follows a fulfilled 3xx without asking route again, so a 3xx is never
// fulfilled. A 3xx of the main document aborts that navigation and the renderer navigates to the
// new location itself (checked again, robots included), at most `maxRedirects` times. A
// subresource's redirects are followed in Node, each hop checked.
//
// Limits per render: a hard timeout, a total response budget (requests past it are aborted), a
// request count, media and fonts blocked, only GET and HEAD unless POST is allowed.
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright-core";
import { BlockedError, BudgetError, type Guard } from "./guard.ts";
import { htmlToMarkdown, truncateUtf8 } from "./markdown.ts";
import type { Robots } from "./robots.ts";

export type RenderRequest = { url: string; format: "markdown" | "png"; waitMs: number; full: boolean };

export type RenderStats = { requests: number; bytes: number; blocked: number; aborted: number; budgetHit: boolean; documents: number };

export type MarkdownResult = {
  format: "markdown";
  url: string;
  finalUrl: string;
  title: string;
  status: number;
  markdown: string;
  bytes: number;
  truncated: boolean;
  renderedMs: number;
  stats: RenderStats;
};

export type PngResult = {
  format: "png";
  url: string;
  finalUrl: string;
  title: string;
  status: number;
  png: Buffer;
  width: number;
  height: number;
  renderedMs: number;
  stats: RenderStats;
};

export type RenderResult = MarkdownResult | PngResult;

export interface Renderer {
  render(req: RenderRequest, signal?: AbortSignal): Promise<RenderResult>;
  close(): Promise<void>;
  readonly ready?: boolean;
}

/** A render that could not be done, with the HTTP status and error code to answer with. */
export class RenderError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RenderError";
    this.status = status;
    this.code = code;
  }
}

export type Limits = {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  maxRequests: number;
  blockMedia: boolean;
  allowPost: boolean;
  markdownMaxBytes: number;
  pngMaxHeight: number;
  width: number;
  height: number;
  /** Largest serialized DOM converted to markdown. */
  maxHtmlChars: number;
};

export const DEFAULT_LIMITS: Limits = {
  timeoutMs: 20_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 2,
  maxRequests: 300,
  blockMedia: true,
  allowPost: false,
  markdownMaxBytes: 200 * 1024,
  pngMaxHeight: 8000,
  width: 1280,
  height: 800,
  maxHtmlChars: 8_000_000,
};

export type ChromiumOptions = {
  executablePath: string;
  guard: Guard;
  robots: Robots;
  userAgent: string;
  limits?: Partial<Limits>;
  sandbox?: boolean;
  log?: (e: Record<string, unknown>) => void;
};

const MAIN_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain|text\/xml|application\/xml|image\/)/i;

/** Where a URL points, for logs: host and path, never the query. */
export function hostPath(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.host}${u.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

function withoutHash(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  return u.href;
}

function pngSize(buf: Buffer): { width: number; height: number } {
  return buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : { width: 0, height: 0 };
}

export class ChromiumRenderer implements Renderer {
  private browser: Promise<Browser> | undefined;
  private connected = false;
  private readonly o: ChromiumOptions;
  readonly limits: Limits;

  constructor(o: ChromiumOptions) {
    this.o = o;
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
  }

  get ready(): boolean {
    return this.connected;
  }

  private launch(): Promise<Browser> {
    if (this.browser) return this.browser;
    const p = chromium
      .launch({
        executablePath: this.o.executablePath,
        headless: true,
        chromiumSandbox: this.o.sandbox ?? false,
        args: [
          // nothing leaves Chromium except through route: a dead proxy for everything else
          "--proxy-server=http://127.0.0.1:9",
          "--proxy-bypass-list=<-loopback>",
          "--disable-quic",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-domain-reliability",
          "--disable-sync",
          "--no-pings",
          "--mute-audio",
          "--disable-dev-shm-usage",
          "--js-flags=--max-old-space-size=512",
        ],
      })
      .then((b) => {
        this.connected = true;
        b.on("disconnected", () => {
          this.connected = false;
          if (this.browser === p) this.browser = undefined;
          this.o.log?.({ evt: "browser_disconnected" });
        });
        this.o.log?.({ evt: "browser_launched", version: b.version() });
        return b;
      });
    p.catch(() => {
      if (this.browser === p) this.browser = undefined;
    });
    this.browser = p;
    return p;
  }

  /** Starts Chromium now instead of on the first render. */
  async warm(): Promise<void> {
    await this.launch();
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = undefined;
    if (b) await (await b.catch(() => undefined))?.close().catch(() => {});
  }

  /** Checks a document URL before navigating to it: SSRF policy (DNS included) and robots.txt. */
  private async admitDocument(url: string): Promise<void> {
    try {
      await this.o.guard.check(url);
    } catch (err) {
      if (err instanceof BlockedError) throw new RenderError(403, "blocked_target", err.message);
      throw err;
    }
    if (!(await this.o.robots.allowed(url))) throw new RenderError(403, "robots_disallowed", `robots.txt of ${new URL(url).host} disallows ${new URL(url).pathname} for x429-render`);
  }

  async render(req: RenderRequest, signal?: AbortSignal): Promise<RenderResult> {
    const t0 = Date.now();
    const L = this.limits;
    if (signal?.aborted) throw new RenderError(499, "client_closed", "the client went away");
    const browser = await this.launch();
    const context = await browser.newContext({
      viewport: { width: L.width, height: L.height },
      userAgent: this.o.userAgent,
      javaScriptEnabled: true,
      acceptDownloads: false,
      serviceWorkers: "block",
      locale: "en-US",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => void context.close().catch(() => {});
    signal?.addEventListener("abort", onAbort, { once: true });
    const work = this.run(context, req, t0);
    work.catch(() => {}); // it may reject after the timeout closed the context
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RenderError(504, "render_timeout", `the render took longer than ${L.timeoutMs} ms`)), L.timeoutMs);
    });
    const aborted = new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new RenderError(499, "client_closed", "the client went away")), { once: true }));
    aborted.catch(() => {});
    try {
      return await Promise.race([work, deadline, aborted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      await context.close().catch(() => {});
    }
  }

  private async run(context: BrowserContext, req: RenderRequest, t0: number): Promise<RenderResult> {
    const L = this.limits;
    const deadline = t0 + L.timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    const stats: RenderStats = { requests: 0, bytes: 0, blocked: 0, aborted: 0, budgetHit: false, documents: 0 };
    const budget = { used: 0, max: L.maxBytes };
    const nav = { redirect: undefined as string | undefined, error: undefined as RenderError | undefined, status: 0, ours: undefined as string | undefined };
    const ctrl = new AbortController();
    context.once("close", () => ctrl.abort());

    await context.routeWebSocket("**", (ws) => void ws.close({ code: 1008, reason: "x429-render does not open WebSockets" }));
    let page: Page | undefined;
    context.on("page", (p) => {
      if (page && p !== page) void p.close().catch(() => {}); // popups are not rendered
    });

    const abort = async (route: Route, why: "blockedbyclient" | "aborted" | "failed") => {
      stats.aborted++;
      await route.abort(why).catch(() => {});
    };

    await context.route("**", async (route) => {
      const r = route.request();
      const url = r.url();
      const type = r.resourceType();
      let main = false;
      let mine = false;
      try {
        // requests of popups and workers are not ours to render (service workers are blocked anyway)
        mine = !!page && r.frame().page() === page;
        main = mine && r.isNavigationRequest() && r.frame() === page!.mainFrame();
      } catch {
        mine = false;
      }
      if (!mine) return abort(route, "blockedbyclient");
      if (!/^https?:/i.test(url)) return abort(route, "blockedbyclient");
      if (L.blockMedia && (type === "media" || type === "font")) return abort(route, "blockedbyclient");
      if (type === "eventsource" || type === "websocket" || type === "ping") return abort(route, "blockedbyclient");
      const method = r.method().toUpperCase();
      if (!(method === "GET" || method === "HEAD" || (L.allowPost && method === "POST"))) return abort(route, "blockedbyclient");
      if (++stats.requests > L.maxRequests) return abort(route, "blockedbyclient");
      if (budget.used >= budget.max) {
        stats.budgetHit = true;
        return abort(route, "blockedbyclient");
      }
      if (main) {
        stats.documents++;
        // a navigation the page started itself (not one of ours) is checked like ours, and counts
        if (url !== nav.ours) {
          if (stats.documents > L.maxRedirects + 1) return abort(route, "blockedbyclient");
          try {
            await this.admitDocument(url);
          } catch {
            stats.blocked++;
            return abort(route, "blockedbyclient");
          }
        }
        nav.ours = undefined;
      }
      try {
        const res = await this.o.guard.fetch(url, {
          method,
          headers: await r.allHeaders().catch(() => r.headers()),
          body: method === "POST" ? r.postDataBuffer() : null,
          maxBytes: L.maxBytes,
          budget,
          maxRedirects: main ? 0 : 3,
          timeoutMs: remaining(),
          signal: ctrl.signal,
        });
        stats.bytes = budget.used;
        const isRedirect = res.status >= 300 && res.status < 400 && res.status !== 304;
        if (isRedirect) {
          if (main && res.headers.location) nav.redirect = new URL(res.headers.location, url).href;
          return abort(route, "aborted"); // never fulfil a 3xx: Chromium would follow it unchecked
        }
        if (main) {
          nav.status = res.status;
          const ct = res.headers["content-type"] ?? "";
          if (ct && !MAIN_TYPES.test(ct)) {
            nav.error = new RenderError(415, "unsupported_content_type", `the page is ${ct.split(";")[0]}, not something a browser renders`);
            return abort(route, "aborted");
          }
        }
        await route.fulfill({ status: res.status, headers: res.headers, body: res.body }).catch(() => {});
      } catch (err) {
        if (err instanceof BlockedError) {
          stats.blocked++;
          if (main) nav.error = new RenderError(403, "blocked_target", err.message);
        } else if (err instanceof BudgetError) {
          stats.budgetHit = true;
          stats.bytes = budget.used;
          if (main) nav.error = new RenderError(413, "too_large", `the page is larger than ${L.maxBytes} bytes`);
        } else if (main) {
          nav.error = new RenderError(502, "fetch_failed", `could not fetch ${hostPath(url)}: ${String((err as Error)?.message ?? err).split("\n")[0]}`);
        }
        return abort(route, "failed");
      }
    });

    page = await context.newPage();
    let target = req.url;
    let committed = false;
    for (let hop = 0; ; hop++) {
      await this.admitDocument(target);
      nav.redirect = undefined;
      nav.error = undefined;
      nav.ours = withoutHash(target);
      try {
        // keep a few seconds of the budget for the wait and the extraction
        await page.goto(target, { waitUntil: "load", timeout: Math.max(1000, remaining() - 3000) });
        committed = true;
      } catch (err) {
        if (nav.error) throw nav.error;
        if (nav.redirect) {
          if (hop >= L.maxRedirects) throw new RenderError(508, "too_many_redirects", `more than ${L.maxRedirects} redirects`);
          target = nav.redirect;
          continue;
        }
        const msg = String((err as Error)?.message ?? err).split("\n")[0]!;
        // the document arrived but `load` did not (a hanging subresource): render what is there
        if (/Timeout/i.test(msg) && nav.status > 0) committed = true;
        else throw new RenderError(502, "navigation_failed", `could not load ${hostPath(target)}: ${msg.replace(/^page\.goto: /, "")}`);
      }
      break;
    }
    if (!committed) throw new RenderError(502, "navigation_failed", "the page did not load");
    const wait = Math.min(req.waitMs, Math.max(0, remaining() - 2000));
    if (wait > 0) await page.waitForTimeout(wait);
    // a navigation the page started during the wait: give it what time is left to finish
    await page.waitForLoadState("load", { timeout: Math.max(1, Math.min(2000, remaining() - 1500)) }).catch(() => {});

    const title = (await page.title().catch(() => "")).trim();
    const finalUrl = page.url();
    const base = { url: req.url, finalUrl, title, status: nav.status, stats };
    if (req.format === "png") {
      let height = L.height;
      if (req.full) {
        const h = await page.evaluate(() => Math.max(document.documentElement?.scrollHeight ?? 0, document.body?.scrollHeight ?? 0));
        height = Math.min(Math.max(Math.ceil(Number(h) || 0), L.height), L.pngMaxHeight);
      }
      const png = await page.screenshot({
        type: "png",
        timeout: remaining(),
        ...(req.full ? { fullPage: true, clip: { x: 0, y: 0, width: L.width, height } } : {}),
      });
      return { ...base, format: "png", png, ...pngSize(png), renderedMs: Date.now() - t0 };
    }
    const html = await page.evaluate((max) => {
      const s = document.documentElement ? document.documentElement.outerHTML : "";
      return s.length > max ? null : s;
    }, L.maxHtmlChars);
    if (html === null) throw new RenderError(413, "too_large", `the rendered page is over ${L.maxHtmlChars} characters`);
    const ex = htmlToMarkdown(html, finalUrl);
    const cut = truncateUtf8(ex.markdown, L.markdownMaxBytes);
    return {
      ...base,
      title: title || ex.title,
      format: "markdown",
      markdown: cut.text,
      bytes: Buffer.byteLength(cut.text, "utf8"),
      truncated: cut.truncated,
      renderedMs: Date.now() - t0,
    };
  }
}
