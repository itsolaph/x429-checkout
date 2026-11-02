// Dashboard: polls the server's /feed (which indexes the contract's events) and renders the line as a
// strip of tickets, the last skip as a receipt, the totals, the ledger and who got paid.
// API origin: same origin, or ?api=https://host. Rendering is keyed: rows that did not change keep
// their DOM nodes, so a poll every 1.5 s never re-animates the page.

type Ticket = { position: number; ticketId: string; owner: string; skipPrice: string; timesPassed: number; earned: string; demo?: boolean };
type FeedEvent = { kind: string; block: string; time: number; tx: string; ticketId?: string; owner?: string; amount?: string; data: Record<string, any> };
type FeedResponse = {
  chainId: number;
  contract: string;
  queueId: number;
  explorer: string;
  /** The operator's own demo agents (lowercase addresses), labeled in every panel. */
  demoAgents?: string[];
  serviceIntervalMs?: number;
  /** Indexing progress (block numbers as decimal strings). caughtUp false: totals are still incomplete. */
  sync?: { next: string; head: string; caughtUp: boolean };
  totals: { paidToWaiting: string; fees: string; claimed: string; paidOut?: string; skips: number; passes: number; served: number; joins: number; earnedBy: Record<string, string> };
  queue: { length: number; feeBps: number; maxLength?: number; joined?: string; tickets: Ticket[] };
  events: FeedEvent[];
};

const params = new URLSearchParams(location.search);
const API = (params.get("api") ?? "").replace(/\/$/, "");
const POLL_MS = Number(params.get("poll") ?? 1500);
const LEDGER_ROWS = 12;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reduceMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const nextFrame = (fn: () => void) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => requestAnimationFrame(fn)) : setTimeout(fn, 0));

function usd(units: string | bigint | number | undefined, digits = 6): string {
  const n = Number(units ?? 0) / 1e6;
  if (n === 0) return "$0";
  return `$${n.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "")}`;
}

const big = (v: string | number | bigint | undefined) => BigInt(v ?? 0);
const int = (v: string | number) => Number(v).toLocaleString("en-US");

let DEMO = new Set<string>();
/** earnedBy is keyed by lowercase address; show the checksummed form seen in tickets or events. */
const CASED = new Map<string, string>();
const isDemo = (addr = "") => DEMO.has(addr.toLowerCase());
const short = (addr = "") => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "");

function el(tag: string, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}

function setText(node: Element, text: string) {
  if (node.textContent !== text) node.textContent = text;
}

/** An address in mono, with "(demo agent)" in plain text after it when the operator runs it. */
function who(addr = ""): HTMLElement {
  const span = el("span", { class: "who" }, el("span", { class: "hex", title: addr }, short(addr)));
  if (isDemo(addr)) span.append(" ", el("span", { class: "who-note" }, "(demo agent)"));
  return span;
}

/** A small ink identicon per address, so the same agent is easy to follow across panels without colour. */
function chip(addr = ""): Element {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "chip");
  svg.setAttribute("viewBox", "-1 -1 7 7");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("shape-rendering", "crispEdges");
  let h = 2166136261;
  for (const c of addr.toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++) {
      if (!((h >>> (y * 3 + x)) & 1)) continue;
      for (const cx of new Set([x, 4 - x])) {
        const r = document.createElementNS(ns, "rect");
        r.setAttribute("x", String(cx));
        r.setAttribute("y", String(y));
        r.setAttribute("width", "1");
        r.setAttribute("height", "1");
        svg.append(r);
      }
    }
  return svg;
}

function ago(t: number): string {
  const s = Math.max(0, Math.round(Date.now() / 1000 - t));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

let explorer = "https://basescan.org";
const txHref = (hash: string) => `${explorer}/tx/${hash}`;
const txLink = (hash: string, text: string, cls = "") => el("a", { href: txHref(hash), target: "_blank", rel: "noopener", class: cls }, text);

/** Base makes a block every 2 s; an index this close to the head is current, not "catching up". */
const BEHIND_BLOCKS = 50n;

/** Indexing is behind when the server says so, or (older servers) when the contract has history but the index is empty. */
function catchingUp(f: FeedResponse): boolean {
  if (f.sync) return !f.sync.caughtUp && big(f.sync.head) - big(f.sync.next) > BEHIND_BLOCKS;
  return f.events.length === 0 && Number(f.queue.joined ?? 0) > 0;
}

// ---------------------------------------------------------------------------------------------------
// The line

type TicketView = { li: HTMLElement; pos: HTMLElement; addr: HTMLElement; note: HTMLElement; price: HTMLElement; stamp: HTMLElement; data?: Ticket };
const views = new Map<string, TicketView>();
let dealt = false;

function ticketView(t: Ticket): TicketView {
  const pos = el("span", { class: "pos" });
  const addr = el("span", { class: "hex" });
  const note = el("span", { class: "who-note" });
  const price = el("b");
  const stamp = el("span", { class: "stamp", "aria-hidden": "true" });
  const li = el(
    "li",
    { class: "ticket", "data-id": t.ticketId },
    el("div", { class: "paper" }, el("div", { class: "face" }, pos), el("div", { class: "stub" }, addr, note, el("span", { class: "ask" }, "asks ", price, " ", el("span", { class: "nowrap" }, "to be passed")))),
    stamp,
  );
  return { li, pos, addr, note, price, stamp };
}

function fillTicket(v: TicketView, t: Ticket) {
  const prev = v.data;
  v.data = t;
  if (prev?.position !== t.position) {
    v.pos.replaceChildren(el("span", { class: "hash" }, "#"), String(t.position));
    v.li.setAttribute("aria-label", `Ticket ${t.ticketId}, number ${t.position} in line`);
  }
  if (prev?.owner !== t.owner) {
    setText(v.addr, short(t.owner));
    v.addr.title = t.owner;
  }
  setText(v.note, t.demo || isDemo(t.owner) ? "demo agent" : "");
  setText(v.price, usd(t.skipPrice));
}

function stampTicket(v: TicketView, amount: string) {
  v.stamp.textContent = `+${usd(amount)}`;
  v.stamp.classList.remove("on");
  void v.stamp.offsetWidth;
  v.stamp.classList.add("on");
}

function renderQueue(f: FeedResponse) {
  const list = $("queue");
  const tickets = f.queue.tickets;
  const motion = !reduceMotion();

  // First: where every ticket was, and in which order.
  const before = new Map<string, number>();
  const oldIndex = new Map<string, number>();
  for (const [id, v] of views) {
    before.set(id, v.li.getBoundingClientRect().left);
    oldIndex.set(id, v.data ? v.data.position : 0);
  }
  const newIndex = new Map(tickets.map((t) => [t.ticketId, t.position]));

  // Tickets that left (served or gone) lift off the strip in place, then go.
  for (const [id, v] of views) {
    if (newIndex.has(id)) continue;
    views.delete(id);
    if (motion && dealt) {
      v.li.style.position = "absolute";
      v.li.style.left = `${v.li.offsetLeft}px`;
      v.li.style.top = `${v.li.offsetTop}px`;
      v.li.classList.add("leaving");
      setTimeout(() => v.li.remove(), 440);
    } else v.li.remove();
  }

  // Keyed update: reuse each ticket's node, only reorder when the order changed. Scroll snapping would
  // follow the old #1 to its new place, so a strip that showed the front keeps showing the front.
  const strip = $("strip");
  const atFront = strip.scrollLeft < 2;
  const fresh: TicketView[] = [];
  tickets.forEach((t, i) => {
    let v = views.get(t.ticketId);
    if (!v) {
      v = ticketView(t);
      views.set(t.ticketId, v);
      fresh.push(v);
    }
    fillTicket(v, t);
    v.li.style.setProperty("--i", String(i));
    const at = list.querySelectorAll(":scope > li:not(.leaving)")[i];
    if (at !== v.li) list.insertBefore(v.li, at ?? null);
  });
  if (atFront && strip.scrollLeft !== 0) strip.scrollLeft = 0;

  if (!dealt && tickets.length) {
    dealt = true;
    if (motion) {
      list.classList.add("deal");
      setTimeout(() => list.classList.remove("deal"), tickets.length * 40 + 480);
    }
  } else if (motion) for (const v of fresh) v.li.classList.add("joining");

  // A skip: a ticket overtook tickets that were ahead of it. The mover slides forward; each ticket it
  // passed gets a stamp for its posted price.
  const movers = new Set<string>();
  for (const t of tickets) {
    const o = oldIndex.get(t.ticketId);
    if (o === undefined) continue;
    for (const u of tickets) {
      const ou = oldIndex.get(u.ticketId);
      if (ou === undefined || u === t) continue;
      if (ou < o && newIndex.get(u.ticketId)! > t.position) {
        movers.add(t.ticketId);
        stampTicket(views.get(u.ticketId)!, u.skipPrice);
      }
    }
  }

  // Last, invert, play: slide every ticket that moved from where it was.
  if (motion) {
    for (const [id, x] of before) {
      const v = views.get(id);
      if (!v) continue;
      const dx = x - v.li.getBoundingClientRect().left;
      if (Math.abs(dx) < 1) continue;
      v.li.classList.toggle("skipper", movers.has(id));
      v.li.style.transition = "none";
      v.li.style.transform = `translateX(${dx}px)${movers.has(id) ? " translateY(-12px)" : ""}`;
      void v.li.offsetWidth;
      v.li.style.transition = `transform ${movers.has(id) ? 720 : 520}ms cubic-bezier(.2,.7,.2,1)`;
      v.li.style.transform = "";
      v.li.addEventListener(
        "transitionend",
        () => {
          v.li.style.transition = "";
          v.li.classList.remove("skipper");
        },
        { once: true },
      );
    }
  }

  // Now serving, the next slot, and the price of #1.
  const n = tickets.length;
  const head = tickets[0];
  $("serving").hidden = !head;
  if (head) setText($("serving-ticket"), `ticket ${head.ticketId}`);
  const roomLeft = n < (f.queue.maxLength ?? 64);
  $("next-slot").hidden = !n || !roomLeft;
  setText($("next-pos"), `#${n + 1}`);

  const empty = $("queue-empty");
  empty.hidden = n > 0;
  if (!n) setText(empty, "Nobody is waiting. The API admits the next request directly.");

  const sum = tickets.reduce((s, t) => s + big(t.skipPrice), 0n);
  const fee = (sum * BigInt(f.queue.feeBps)) / 10_000n;
  const fp = $("front-price");
  const key = `${n}|${sum + fee}|${f.queue.feeBps}`;
  if (fp.dataset.key !== key) {
    fp.dataset.key = key;
    fp.replaceChildren(
      ...(n
        ? [
            `${n} ${n === 1 ? "ticket" : "tickets"} in line. Reaching #1 costs `,
            el("b", {}, usd(sum + fee)),
            f.queue.feeBps ? ` right now, including the ${f.queue.feeBps / 100}% fee.` : " right now.",
          ]
        : ["The line is empty right now."]),
    );
  }
}

// ---------------------------------------------------------------------------------------------------
// Last skip, as a receipt

let receiptKey = "";
function renderLastSkip(f: FeedResponse, behind: boolean) {
  const skip = f.events.find((e) => e.kind === "skipped");
  const head = $("lastskip-headline");
  const link = $<HTMLAnchorElement>("lastskip-tx");
  const list = $("lastskip-payouts");
  if (!skip) {
    link.hidden = true;
    setText($("lastskip-when"), "");
    head.classList.add("quiet");
    setText(head, behind ? "Catching up on Base history. The last skip shows once the index reaches it." : "No skips yet. The first agent to pay moves up and pays every agent it passes.");
    list.replaceChildren();
    receiptKey = "";
    return;
  }
  const passed = f.events.filter((e) => e.kind === "passed" && e.tx === skip.tx).reverse();
  const payouts = f.events.filter((e) => e.kind === "paid_out" && big(e.block) >= big(skip.block)).reverse();
  head.classList.remove("quiet");
  setText(head, `#${skip.data.fromPosition} to #${skip.data.toPosition}, paid ${usd(skip.data.compensation)}, ${passed.length} ${passed.length === 1 ? "agent" : "agents"} paid`);
  link.hidden = false;
  link.href = txHref(skip.tx);
  setText($("lastskip-when"), `Skipped ${ago(skip.time)}.`);

  const isNew = skip.tx !== receiptKey;
  if (isNew) {
    const animate = receiptKey !== "" && !reduceMotion();
    receiptKey = skip.tx;
    list.className = `payouts${animate ? " fresh" : ""}`;
    list.replaceChildren(
      ...passed.map((p, i) =>
        el(
          "li",
          { class: "payout", style: `--i:${i}`, "data-owner": (p.owner ?? "").toLowerCase() },
          chip(p.owner),
          who(p.owner),
          el("span", { class: "state" }),
          el("span", { class: "amt" }, `+${usd(p.amount)}`),
          txLink(skip.tx, short(skip.tx), "tx hex"),
        ),
      ),
    );
  }
  // Only the status and the link change while a payout is being sent.
  for (const row of list.children) {
    const owner = (row as HTMLElement).dataset.owner ?? "";
    const out = payouts.find((e) => (e.owner ?? "").toLowerCase() === owner);
    setText(row.querySelector(".state")!, out ? "in wallet" : "sending");
    const a = row.querySelector<HTMLAnchorElement>(".tx")!;
    const tx = out ? out.tx : skip.tx;
    if (a.getAttribute("href") !== txHref(tx)) {
      a.href = txHref(tx);
      a.textContent = short(tx);
    }
    a.title = out ? "The payout to this wallet on Basescan" : "The skip transaction on Basescan";
  }
}

// ---------------------------------------------------------------------------------------------------
// Totals, with rolling digits

function setFigure(id: string, text: string | null) {
  const dd = $(id);
  if (text === null) {
    if (dd.dataset.v === "") return;
    dd.dataset.v = "";
    dd.classList.add("skeleton");
    dd.replaceChildren(el("span", { class: "sr-only" }, "Catching up"));
    return;
  }
  if (dd.dataset.v === text) return;
  const prev = dd.dataset.v;
  dd.dataset.v = text;
  dd.classList.remove("skeleton");
  const shape = (s: string) => s.replace(/\d/g, "0");
  const rolls = dd.querySelectorAll<HTMLElement>(".roll > span");
  const move = (stack: HTMLElement, d: number) => (stack.style.transform = `translateY(${-d}em)`);
  dd.querySelector(".sr-only")?.replaceChildren(text);
  if (prev && shape(prev) === shape(text) && rolls.length) {
    let k = 0;
    for (const ch of text) if (/\d/.test(ch)) move(rolls[k++]!, Number(ch));
    return;
  }
  const visual = el("span", { "aria-hidden": "true" });
  const stacks: [HTMLElement, number][] = [];
  for (const ch of text) {
    if (!/\d/.test(ch)) {
      visual.append(el("span", {}, ch));
      continue;
    }
    const stack = el("span", {}, ...Array.from({ length: 10 }, (_, d) => el("span", {}, String(d))));
    stacks.push([stack, Number(ch)]);
    visual.append(el("span", { class: "roll" }, stack));
  }
  dd.replaceChildren(el("span", { class: "sr-only" }, text), visual);
  const roll = prev !== undefined && prev !== "" && !reduceMotion();
  for (const [s, d] of stacks) move(s, roll ? 0 : d);
  if (roll) nextFrame(() => stacks.forEach(([s, d]) => move(s, d)));
}

function renderTotals(f: FeedResponse, behind: boolean) {
  const note = $("totals-note");
  $("figures").setAttribute("aria-busy", String(behind));
  if (behind) {
    for (const id of ["paid-total", "s-skips", "s-passes", "s-served"]) setFigure(id, null);
    const s = f.sync;
    setText(
      note,
      s
        ? `Catching up on Base history: read to block ${int(s.next)} of ${int(s.head)}, ${int(Math.max(0, Number(s.head) - Number(s.next)))} to go. The totals appear when it reaches today.`
        : "Catching up on Base history. The totals appear once the server has read the contract’s past events.",
    );
    return;
  }
  setFigure("paid-total", usd(f.totals.paidToWaiting));
  setFigure("s-skips", int(f.totals.skips));
  setFigure("s-passes", int(f.totals.passes));
  setFigure("s-served", int(f.totals.served));
  const inWallets = big(f.totals.claimed) + big(f.totals.paidOut);
  const key = `${inWallets}|${f.totals.fees}`;
  if (note.dataset.key !== key) {
    note.dataset.key = key;
    note.replaceChildren(
      el("b", {}, usd(inWallets)),
      " of it is already in wallets.",
      ...(big(f.totals.fees) > 0n ? [" Operator fees so far: ", el("b", {}, usd(f.totals.fees)), "."] : []),
    );
  }
}

// ---------------------------------------------------------------------------------------------------
// Ledger

function describe(e: FeedEvent): (Node | string)[] {
  const amt = (v?: string | bigint) => el("span", { class: "amt-ink" }, usd(v));
  switch (e.kind) {
    case "skipped":
      return [
        who(e.owner),
        ` skipped from #${e.data.fromPosition} to #${e.data.toPosition} and paid `,
        amt(e.data.compensation),
        " to the agents passed",
        ...(big(e.data.fee) > 0n ? [", plus a fee of ", amt(e.data.fee)] : []),
        ...(big(e.data.refund) > 0n ? [", refunded ", amt(e.data.refund)] : []),
        ".",
      ];
    case "passed":
      return [who(e.owner), ` was passed by ticket ${e.data.byTicketId} and earned `, amt(e.amount), "."];
    case "joined":
      return [who(e.owner), ` joined at #${e.data.position}, asks `, amt(e.data.skipPrice), " to be passed."];
    case "served":
      return [who(e.owner), ` was served after ${e.data.waited}s`, Number(e.data.timesPassed) > 0 ? `, passed ${e.data.timesPassed} ${Number(e.data.timesPassed) === 1 ? "time" : "times"} for ${usd(e.data.earned)}.` : "."];
    case "claimed":
      return [who(e.owner), " claimed ", amt(e.amount), "."];
    case "paid_out":
      return [who(e.owner), " received ", amt(e.amount), " in its wallet."];
    case "left":
      return [who(e.owner), " left the line."];
    case "refunded":
      return [who(e.owner), " was refunded ", amt(e.amount), " because the skip was no longer possible."];
    default:
      return [e.kind];
  }
}

const rows = new Map<string, { tr: HTMLElement; when: HTMLElement; time: number }>();
let ledgerAll = false;
let lastFeed: FeedResponse | null = null;

function renderFeed(f: FeedResponse, behind: boolean) {
  const body = $("feed");
  const seen = new Map<string, number>();
  const shown = ledgerAll ? f.events : f.events.slice(0, LEDGER_ROWS);
  const keep = new Set<string>();
  shown.forEach((e, i) => {
    const base = `${e.tx}|${e.kind}|${e.ticketId ?? ""}|${e.owner ?? ""}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const key = `${base}|${n}`;
    keep.add(key);
    let r = rows.get(key);
    if (!r) {
      const when = el("td", { class: "when" });
      const tr = el("tr", {}, el("td", { class: `kind ${e.kind}` }, e.kind.replace(/_/g, " ")), el("td", { class: "text" }, ...describe(e)), when);
      r = { tr, when, time: e.time };
      rows.set(key, r);
    }
    const label = ago(e.time);
    if (r.when.textContent !== label) r.when.replaceChildren(txLink(e.tx, label));
    if (body.children[i] !== r.tr) body.insertBefore(r.tr, body.children[i] ?? null);
  });
  for (const [key, r] of rows) {
    if (keep.has(key)) continue;
    r.tr.remove();
    rows.delete(key);
  }
  const empty = $("feed-empty");
  empty.hidden = f.events.length > 0;
  $("feed-table").hidden = !f.events.length;
  setText(empty, behind ? "Catching up on Base history. The ledger fills in as the index reaches today." : "Nothing has happened on the line yet.");
  const more = $<HTMLButtonElement>("feed-more");
  more.hidden = f.events.length <= LEDGER_ROWS;
  setText(more, ledgerAll ? `Show the newest ${LEDGER_ROWS}` : `Show all ${f.events.length} entries`);
}

// ---------------------------------------------------------------------------------------------------
// Who got paid

const earners = new Map<string, { li: HTMLElement; amt: HTMLElement; bar: HTMLElement }>();
function renderEarners(f: FeedResponse, behind: boolean) {
  const list = $("earners");
  const entries = Object.entries(f.totals.earnedBy).sort((a, b) => (big(b[1]) > big(a[1]) ? 1 : big(b[1]) < big(a[1]) ? -1 : 0));
  const max = entries.length ? Number(entries[0]![1]) || 1 : 1;
  const keep = new Set<string>();
  entries.forEach(([addr, v], i) => {
    const key = addr.toLowerCase();
    keep.add(key);
    let r = earners.get(key);
    if (!r) {
      const amt = el("span", { class: "money" });
      const bar = el("div", { class: "bar" });
      const shown = CASED.get(key) ?? addr;
      const li = el("li", { class: "earner" }, chip(key), who(shown), amt, el("div", { class: "track", "aria-hidden": "true" }, bar));
      r = { li, amt, bar };
      earners.set(key, r);
    }
    setText(r.amt, usd(v));
    r.bar.style.transform = `scaleX(${Math.max(0.02, Number(v) / max)})`;
    if (list.children[i] !== r.li) list.insertBefore(r.li, list.children[i] ?? null);
  });
  for (const [key, r] of earners) {
    if (keep.has(key)) continue;
    r.li.remove();
    earners.delete(key);
  }
  const empty = $("earners-empty");
  empty.hidden = entries.length > 0;
  setText(empty, behind ? "Catching up on Base history. Earnings appear as the index reaches them." : "Nobody has been passed yet.");
}

// ---------------------------------------------------------------------------------------------------

function render(f: FeedResponse) {
  lastFeed = f;
  DEMO = new Set((f.demoAgents ?? []).map((a) => a.toLowerCase()));
  for (const o of [...f.queue.tickets.map((t) => t.owner), ...f.events.map((e) => e.owner)]) if (o && o !== o.toLowerCase()) CASED.set(o.toLowerCase(), o);
  explorer = f.explorer;
  const behind = catchingUp(f);
  setText($("live-dot"), "Live");
  setText($("net-sep"), " on ");
  setText($("net-label"), f.chainId === 8453 ? "Base mainnet" : `chain ${f.chainId}`);
  const link = $<HTMLAnchorElement>("contract-link");
  setText(link, short(f.contract));
  link.title = f.contract;
  link.href = `${f.explorer}/address/${f.contract}`;
  setText($("queue-id"), String(f.queueId));
  const src = $("source");
  const origin = `${API || location.origin}/feed`;
  if (src.dataset.origin !== origin) {
    src.dataset.origin = origin;
    src.replaceChildren("Data comes from ", el("code", {}, origin), ", which indexes the contract’s events.");
  }
  renderQueue(f);
  renderLastSkip(f, behind);
  renderTotals(f, behind);
  renderFeed(f, behind);
  renderEarners(f, behind);
}

$("feed-more").addEventListener("click", () => {
  ledgerAll = !ledgerAll;
  if (lastFeed) renderFeed(lastFeed, catchingUp(lastFeed));
});

let connected = false;
async function tick() {
  const live = $("live-dot");
  try {
    const res = await fetch(`${API}/feed?limit=120`, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    render((await res.json()) as FeedResponse);
    connected = true;
    live.className = "live on";
  } catch {
    live.className = "live err";
    setText(live, "Reconnecting");
    setText($("net-sep"), " to ");
    setText($("net-label"), "the live feed");
    if (!connected) setText($("queue-empty"), "The live line did not load. Retrying every few seconds.");
  } finally {
    setTimeout(tick, POLL_MS);
  }
}

void tick();
