// Renders the built dashboard (site/) against a running server in a DOM (linkedom), without a
// browser, and checks that the live numbers show up. Usage: node scripts/render-check.mjs <api url>
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";

const api = process.argv[2];
if (!api) throw new Error("usage: node scripts/render-check.mjs <api url>");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = await (await fetch(`${api}/`)).text(); // the page as the server serves it
const { window, document } = parseHTML(html);
const location = new URL(`${api}/?api=${encodeURIComponent(api)}&poll=60000`);
Object.assign(globalThis, { window, document, location });

await import(pathToFileURL(join(root, "site/app.js")).href);
const feed = await (await fetch(`${api}/feed?limit=120`)).json();

const deadline = Date.now() + 10_000;
const text = (id) => document.getElementById(id)?.textContent ?? "";
while (Date.now() < deadline && !document.getElementById("live-dot").className.includes("on")) {
  await new Promise((r) => setTimeout(r, 100));
}
const usd = (u) => `$${(Number(u) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
const checks = [
  ["live indicator", document.getElementById("live-dot").className.includes("on")],
  ["network label", text("net-label") === "Base mainnet"],
  ["paid to people waiting", text("paid-total") === usd(feed.totals.paidToWaiting)],
  ["skips counter", text("s-skips") === String(feed.totals.skips)],
  ["ledger rows", document.querySelectorAll("#feed li").length === Math.min(120, feed.events.length)],
  ["line rows", document.querySelectorAll("#queue li").length === feed.queue.tickets.length],
  ["earners rows", document.querySelectorAll("#earners tr").length === Object.keys(feed.totals.earnedBy).length],
  ["demo agents labeled", (feed.demoAgents ?? []).length === 0 || [...document.querySelectorAll("#queue li, #earners tr")].some((n) => n.textContent.includes("(demo agent)"))],
  ["explorer links", [...document.querySelectorAll("#feed a")].every((a) => a.getAttribute("href").startsWith(`${feed.explorer}/tx/0x`))],
];
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`[render] ${ok ? "ok  " : "FAIL"} ${name}`);
console.log(`[render] paid to people waiting ${text("paid-total")}, ${document.querySelectorAll("#feed li").length} ledger rows, ${document.querySelectorAll("#queue li").length} in line`);
// keep the html template honest too
if (!readFileSync(join(root, "site/index.html"), "utf8").includes('src="app.js"')) failed.push(["script tag"]);
process.exit(failed.length ? 1 : 0);
