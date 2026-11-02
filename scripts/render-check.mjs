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
// totals roll their digits: the shown value is the figure's data-v (and its screen-reader text)
const figure = (id) => document.getElementById(id)?.getAttribute("data-v") ?? "";
const LEDGER_ROWS = 12; // web/src/main.ts shows the newest 12 until "Show all"
const skip = feed.events.find((e) => e.kind === "skipped");
const checks = [
  ["live indicator", document.getElementById("live-dot").className.includes("on")],
  ["network label", text("net-label") === "Base mainnet"],
  ["paid to people waiting", figure("paid-total") === usd(feed.totals.paidToWaiting)],
  ["skips counter", figure("s-skips") === Number(feed.totals.skips).toLocaleString("en-US")],
  ["ledger rows", document.querySelectorAll("#feed tr").length === Math.min(LEDGER_ROWS, feed.events.length)],
  ["line rows", document.querySelectorAll("#queue li").length === feed.queue.tickets.length],
  ["earners rows", document.querySelectorAll("#earners li").length === Object.keys(feed.totals.earnedBy).length],
  ["demo agents labeled", (feed.demoAgents ?? []).length === 0 || [...document.querySelectorAll("#queue li, #earners li")].some((n) => n.textContent.includes("demo agent"))],
  ["last skip headline", !!skip && text("lastskip-headline") === `#${skip.data.fromPosition} to #${skip.data.toPosition}, paid ${usd(skip.data.compensation)}, ${feed.events.filter((e) => e.kind === "passed" && e.tx === skip.tx).length} agent${feed.events.filter((e) => e.kind === "passed" && e.tx === skip.tx).length === 1 ? "" : "s"} paid`],
  ["last skip payouts", !!skip && document.querySelectorAll("#lastskip-payouts li").length === feed.events.filter((e) => e.kind === "passed" && e.tx === skip.tx).length],
  ["last skip basescan link", document.getElementById("lastskip-tx").getAttribute("href").startsWith(`${feed.explorer}/tx/0x`)],
  ["explorer links", [...document.querySelectorAll("#feed a")].every((a) => a.getAttribute("href").startsWith(`${feed.explorer}/tx/0x`))],
];
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`[render] ${ok ? "ok  " : "FAIL"} ${name}`);
console.log(`[render] ${text("lastskip-headline")} (${document.querySelectorAll("#lastskip-payouts li").length} payouts)`);
console.log(`[render] paid to people waiting ${figure("paid-total")}, ${figure("s-skips")} skips, ${document.querySelectorAll("#feed tr").length} ledger rows, ${document.querySelectorAll("#queue li").length} in line, ${document.querySelectorAll("#earners li").length} earners`);
// keep the html template honest too
if (!readFileSync(join(root, "site/index.html"), "utf8").includes('src="app.js"')) failed.push(["script tag"]);
process.exit(failed.length ? 1 : 0);
