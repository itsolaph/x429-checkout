// Dashboard: polls the server's /feed (which indexes the contract's events) and renders the line,
// the ledger and who got paid. API origin: same origin, or ?api=http://host:port.

type Ticket = { position: number; ticketId: string; owner: string; skipPrice: string; timesPassed: number; earned: string };
type FeedEvent = { kind: string; block: string; time: number; tx: string; ticketId?: string; owner?: string; amount?: string; data: Record<string, any> };
type FeedResponse = {
  chainId: number;
  contract: string;
  queueId: number;
  explorer: string;
  /** The operator's own demo agents (lowercase addresses), labeled in every panel. */
  demoAgents?: string[];
  serviceIntervalMs?: number;
  totals: { paidToWaiting: string; fees: string; claimed: string; paidOut?: string; skips: number; passes: number; served: number; joins: number; earnedBy: Record<string, string> };
  queue: { length: number; feeBps: number; tickets: Ticket[] };
  events: FeedEvent[];
};

const params = new URLSearchParams(location.search);
const API = (params.get("api") ?? "").replace(/\/$/, "");
const POLL_MS = Number(params.get("poll") ?? 1500);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function usd(units: string | bigint | number | undefined, digits = 6): string {
  const n = Number(units ?? 0) / 1e6;
  if (n === 0) return "$0";
  return `$${n.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "")}`;
}

let DEMO = new Set<string>();

function short(addr = ""): string {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}${DEMO.has(addr.toLowerCase()) ? " (demo agent)" : ""}`;
}

/** A stable color per address, so the same agent is easy to follow across panels. */
function hue(addr = ""): string {
  let h = 0;
  for (let i = 2; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 58%)`;
}

function el(tag: string, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "style") e.setAttribute("style", v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}

function chip(addr: string): HTMLElement {
  return el("span", { class: "chip", style: `background:${hue(addr)}`, title: addr });
}

function ago(t: number): string {
  const s = Math.max(0, Math.round(Date.now() / 1000 - t));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

let explorer = "https://basescan.org";
const txLink = (hash: string, text: string) => el("a", { href: `${explorer}/tx/${hash}`, target: "_blank", rel: "noopener", class: "mono" }, text);

let lastOrder = "";

function renderQueue(f: FeedResponse) {
  const list = $("queue");
  const order = f.queue.tickets.map((t) => t.ticketId).join(",");
  const prevPos = new Map(lastOrder.split(",").map((id, i) => [id, i + 1]));
  list.replaceChildren(
    ...f.queue.tickets.map((t) => {
      const was = prevPos.get(t.ticketId);
      const moved = lastOrder !== "" && was !== undefined && was > t.position + 0 && was - t.position > 1;
      const li = el(
        "li",
        { class: `${t.position === 1 ? "head" : ""} ${moved ? "moved" : ""}` },
        el("span", { class: "pos" }, `#${t.position}`),
        el(
          "span",
          { class: "who" },
          chip(t.owner),
          el("span", { class: "mono" }, short(t.owner)),
          ...(t.position === 1 ? [el("span", { class: "tag" }, "next")] : []),
          ...(t.timesPassed > 0 ? [el("span", { class: "meta" }, `passed ×${t.timesPassed}, earned ${usd(t.earned)}`)] : []),
        ),
        el("span", { class: "price" }, usd(t.skipPrice), el("small", {}, "to pass")),
      );
      return li;
    }),
  );
  lastOrder = order;
  $("queue-empty").style.display = f.queue.tickets.length ? "none" : "block";
  const sum = f.queue.tickets.reduce((s, t) => s + BigInt(t.skipPrice), 0n);
  const fee = (sum * BigInt(f.queue.feeBps)) / 10_000n;
  $("front-price").textContent = f.queue.tickets.length
    ? `a newcomer reaches #1 for ${usd(sum + fee)}${f.queue.feeBps ? ` (incl. ${f.queue.feeBps / 100}% fee)` : ""}`
    : "";
}

function describe(e: FeedEvent): (Node | string)[] {
  const who = (a?: string) => el("span", { class: "mono", title: a ?? "" }, short(a));
  const amt = (v?: string | bigint) => el("span", { class: "amt" }, usd(v));
  switch (e.kind) {
    case "skipped":
      return [who(e.owner), ` moved #${e.data.fromPosition} → #${e.data.toPosition}, paid `, amt(e.data.compensation), ` to the agents passed`, ...(BigInt(e.data.fee ?? 0) > 0n ? [" + fee ", amt(e.data.fee)] : []), BigInt(e.data.refund ?? 0) > 0n ? ` · refunded ${usd(e.data.refund)}` : ""];
    case "passed":
      return [who(e.owner), " was passed by ticket ", el("span", { class: "mono" }, `#${e.data.byTicketId}`), " and earned ", amt(e.amount)];
    case "joined":
      return [who(e.owner), ` joined at #${e.data.position}, asks `, amt(e.data.skipPrice), " to be passed"];
    case "served":
      return [who(e.owner), ` served after ${e.data.waited}s`, Number(e.data.timesPassed) > 0 ? `, passed ${e.data.timesPassed}× for ${usd(e.data.earned)}` : ""];
    case "claimed":
      return [who(e.owner), " claimed ", amt(e.amount)];
    case "paid_out":
      return [who(e.owner), " received ", amt(e.amount), " automatically"];
    case "left":
      return [who(e.owner), " left the line"];
    case "refunded":
      return [who(e.owner), " was refunded ", amt(e.amount), " (front-run payment, skip no longer possible)"];
    default:
      return [e.kind];
  }
}

function renderFeed(f: FeedResponse) {
  $("feed").replaceChildren(
    ...f.events.map((e) =>
      el(
        "li",
        {},
        el("span", { class: `kind ${e.kind}` }, e.kind),
        el("span", { class: "text" }, ...describe(e)),
        el("span", { class: "when" }, txLink(e.tx, ago(e.time))),
      ),
    ),
  );
}

function renderEarners(f: FeedResponse) {
  const rows = Object.entries(f.totals.earnedBy).sort((a, b) => Number(BigInt(b[1]) - BigInt(a[1])));
  const max = rows.length ? Number(rows[0]![1]) : 1;
  $("earners").replaceChildren(
    ...rows.map(([addr, v]) =>
      el(
        "tr",
        {},
        el("td", {}, el("span", { class: "who", style: "display:flex;gap:8px;align-items:center" }, chip(addr), el("span", { class: "mono" }, short(addr)))),
        el("td", { class: "num" }, usd(v)),
        el("td", { class: "bar-col" }, el("div", { class: "bar", style: `width:${Math.max(2, (Number(v) / max) * 100)}%` })),
      ),
    ),
  );
}

/** The headline number counts up to its new value (instantly without animation support). */
let shown = -1n;
function ticker(total: bigint) {
  const node = $("paid-total");
  const raf = (globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number }).requestAnimationFrame;
  if (shown < 0n || total <= shown || !raf) {
    shown = total;
    node.textContent = usd(total);
    return;
  }
  const from = Number(shown);
  const to = Number(total);
  shown = total;
  node.classList.remove("bump");
  void node.offsetWidth;
  node.classList.add("bump");
  const start = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - start) / 900);
    const eased = 1 - (1 - k) ** 3;
    node.textContent = k < 1 ? usd(Math.round(from + (to - from) * eased)) : usd(total);
    if (k < 1) raf(step);
  };
  raf(step);
}

let lastSkipTx = "";
/** The newest skip: one headline ("skipped ~Ns; K agents earned $X") and each ticket's payout landing. */
function renderLastSkip(f: FeedResponse) {
  const skip = f.events.find((e) => e.kind === "skipped");
  const box = $("lastskip");
  if (!skip) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const passed = f.events.filter((e) => e.kind === "passed" && e.tx === skip.tx).reverse();
  const inWallet = new Set(f.events.filter((e) => e.kind === "paid_out" && BigInt(e.block) >= BigInt(skip.block)).map((e) => (e.owner ?? "").toLowerCase()));
  const places = Number(skip.data.fromPosition) - Number(skip.data.toPosition);
  const saved = Math.round((places * (f.serviceIntervalMs ?? 0)) / 1000);
  $("lastskip-headline").replaceChildren(
    `Skipped ~${saved}s; ${passed.length} agent${passed.length === 1 ? "" : "s"} earned `,
    el("b", {}, usd(skip.data.compensation)),
  );
  const a = $<HTMLAnchorElement>("lastskip-tx");
  a.href = `${explorer}/tx/${skip.tx}`;
  a.textContent = `${skip.tx.slice(0, 10)}… on basescan · ${ago(skip.time)}`;
  const list = $("lastskip-payouts");
  const fresh = skip.tx !== lastSkipTx && lastSkipTx !== "";
  list.className = `payouts${fresh ? " fresh" : ""}`;
  list.replaceChildren(
    ...passed.map((p, i) =>
      el(
        "li",
        fresh ? { style: `animation-delay:${i * 140}ms` } : {},
        chip(p.owner ?? ""),
        el("span", { class: "mono" }, short(p.owner)),
        el("span", { class: "ok" }, inWallet.has((p.owner ?? "").toLowerCase()) ? "in wallet" : "sending"),
        el("span", { class: "amt" }, `+${usd(p.amount)}`),
      ),
    ),
  );
  lastSkipTx = skip.tx;
}

function render(f: FeedResponse) {
  DEMO = new Set((f.demoAgents ?? []).map((a) => a.toLowerCase()));
  explorer = f.explorer;
  $("net-label").textContent = f.chainId === 8453 ? "Base mainnet" : `chain ${f.chainId}`;
  const link = $<HTMLAnchorElement>("contract-link");
  link.textContent = `${short(f.contract)} · queue ${f.queueId}`;
  link.href = `${f.explorer}/address/${f.contract}`;
  ticker(BigInt(f.totals.paidToWaiting));
  $("s-length").textContent = String(f.queue.length);
  $("s-skips").textContent = String(f.totals.skips);
  $("s-passes").textContent = String(f.totals.passes);
  $("s-served").textContent = String(f.totals.served);
  $("s-claimed").textContent = usd(BigInt(f.totals.claimed) + BigInt(f.totals.paidOut ?? 0));
  $("s-fees").textContent = usd(f.totals.fees);
  $("source").textContent = `data: ${API || location.origin}/feed · contract ${f.contract}`;
  renderQueue(f);
  renderLastSkip(f);
  renderFeed(f);
  renderEarners(f);
}

async function tick() {
  const dot = $("live-dot");
  try {
    const res = await fetch(`${API}/feed?limit=120`, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    render((await res.json()) as FeedResponse);
    dot.className = "dot on";
  } catch {
    dot.className = "dot err";
    $("net-label").textContent = "server unreachable";
  } finally {
    setTimeout(tick, POLL_MS);
  }
}

void tick();
