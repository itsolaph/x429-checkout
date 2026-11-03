// The Chromium renderer against a local fixture site: markdown shape, PNG limits, SSRF on every
// browser request (redirects and subresources included), robots.txt, the timeout, the response budget,
// redirect and content-type limits, and a fresh context per render.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ChromiumRenderer, RenderError, type MarkdownResult, type PngResult } from "../src/renderer.ts";
import { Robots } from "../src/robots.ts";
import { CHROMIUM, chromiumSkip, html, redirect, startFixture, testGuard, type Fixture } from "./fixture.ts";

let fx: Fixture;
let renderer: ChromiumRenderer;
const UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/156.0.0.0 Safari/537.36 x429-render/0.1 (+test)";

function make(limits: ConstructorParameters<typeof ChromiumRenderer>[0]["limits"] = {}) {
  const guard = testGuard(fx.port);
  return new ChromiumRenderer({ executablePath: CHROMIUM, guard, robots: new Robots({ guard, token: "x429-render", userAgent: UA }), userAgent: UA, limits: { timeoutMs: 8000, ...limits } });
}

before(async () => {
  fx = await startFixture();
  if (chromiumSkip) return;
  renderer = make();
  await renderer.warm();
});

after(async () => {
  await renderer?.close();
  await fx.close();
});

const md = (url: string, waitMs = 0, r = renderer) => r.render({ url, format: "markdown", waitMs, full: false }) as Promise<MarkdownResult>;
const rejectsWith = (p: Promise<unknown>, status: number, code: string) =>
  assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof RenderError, String(e));
    assert.equal(e.code, code, e.message);
    assert.equal(e.status, status);
    return true;
  });

const ARTICLE = `<header><nav><a href="/">Home</a> <a href="/about">About</a></nav></header>
<main><article><h1>Queues that pay</h1>
<p>${"An API that is busy can sell the front of its line instead of turning callers away. ".repeat(4)}</p>
<p>Read <a href="/more?x=1">the longer version</a> or look at <img src="/pic.png" alt="a ticket">.</p>
<div id="js-slot"></div></article></main>
<script>document.getElementById("js-slot").innerHTML = "<p>Rendered by JavaScript after load: " + (6 * 7) + ".</p>";
document.title = "Queues that pay (rendered)";</script>`;

test("markdown: the page after its JavaScript ran, as { url, finalUrl, title, markdown, bytes, renderedMs }", { skip: chromiumSkip }, async () => {
  fx.routes.set("site.test/article", html(ARTICLE, "<title>Queues</title>"));
  const r = await md("http://site.test/article");
  assert.equal(r.format, "markdown");
  assert.equal(r.url, "http://site.test/article");
  assert.equal(r.finalUrl, "http://site.test/article");
  assert.equal(r.status, 200);
  assert.equal(r.title, "Queues that pay (rendered)", "the title the script set");
  assert.match(r.markdown, /Queues that pay/);
  assert.match(r.markdown, /Rendered by JavaScript after load: 42\./, "JS ran");
  assert.match(r.markdown, /\[the longer version\]\(http:\/\/site\.test\/more\?x=1\)/, "links are absolute");
  assert.match(r.markdown, /!\[a ticket\]\(http:\/\/site\.test\/pic\.png\)/);
  assert.doesNotMatch(r.markdown, /document\.getElementById|<script/, "no script text");
  assert.equal(r.bytes, Buffer.byteLength(r.markdown));
  assert.equal(r.truncated, false);
  assert.ok(r.renderedMs > 0 && r.renderedMs < 8000);
  const docHit = fx.hits.find((h) => h.path === "/article")!;
  assert.match(docHit.ua, /x429-render/, "the user agent names x429-render");
});

test("markdown: a page without an article falls back to the whole body; long output is cut at the cap", { skip: chromiumSkip }, async () => {
  fx.routes.set("site.test/menu", html(`<ul><li><a href="/a">Alpha</a></li><li><a href="/b">Beta</a></li></ul><table><tr><td>cell one</td><td>cell two</td></tr></table>`, "<title>Menu</title>"));
  const r = await md("http://site.test/menu");
  assert.match(r.markdown, /\[Alpha\]\(http:\/\/site\.test\/a\)/);
  assert.match(r.markdown, /cell two/);
  fx.routes.set("site.test/long", html(`<article><h1>Long</h1>${"<p>é ".repeat(10) + "lorem ipsum dolor sit amet ".repeat(12_000)}</p></article>`, "<title>Long</title>"));
  const small = make({ markdownMaxBytes: 50_000 });
  try {
    const l = await md("http://site.test/long", 0, small);
    assert.equal(l.truncated, true);
    assert.ok(l.bytes <= 50_000 && l.bytes > 49_000, String(l.bytes));
    assert.equal(l.bytes, Buffer.byteLength(l.markdown));
    assert.doesNotMatch(l.markdown, /�/, "no broken character at the cut");
  } finally {
    await small.close();
  }
});

test("png: 1280x800 by default; full page is capped at 1280x8000", { skip: chromiumSkip }, async () => {
  fx.routes.set("site.test/tall", html(`<div style="height:12000px;background:linear-gradient(#fff,#e4432d)">tall</div>`, "<title>Tall</title>"));
  const v = (await renderer.render({ url: "http://site.test/tall", format: "png", waitMs: 0, full: false })) as PngResult;
  assert.equal(v.png.subarray(1, 4).toString(), "PNG");
  assert.deepEqual([v.width, v.height], [1280, 800]);
  const f = (await renderer.render({ url: "http://site.test/tall", format: "png", waitMs: 0, full: true })) as PngResult;
  assert.deepEqual([f.width, f.height], [1280, 8000]);
  fx.routes.set("site.test/short", html(`<p>short</p>`));
  const s = (await renderer.render({ url: "http://site.test/short", format: "png", waitMs: 0, full: true })) as PngResult;
  assert.deepEqual([s.width, s.height], [1280, 800], "a short page is one viewport");
});

test("SSRF: a name resolving to 127.0.0.1, a redirect to a private IP and a redirect to a rebinding name are refused", { skip: chromiumSkip }, async () => {
  fx.routes.set("/secret", html("<p>the secret</p>"));
  fx.routes.set("site.test/to-private", redirect("http://10.0.0.1/admin"));
  fx.routes.set("site.test/to-rebind", redirect("http://rebind.test/secret"));
  fx.routes.set("site.test/to-metadata", redirect("http://169.254.169.254/latest/meta-data/iam/"));
  fx.routes.set("site.test/to-port", redirect(`http://site.test:${fx.port}/secret`));
  await rejectsWith(md("http://rebind.test/secret"), 403, "blocked_target");
  await rejectsWith(md("http://meta.test/latest/meta-data/"), 403, "blocked_target");
  await rejectsWith(md("http://mixed.test/"), 403, "blocked_target");
  for (const p of ["/to-private", "/to-rebind", "/to-metadata", "/to-port"]) await rejectsWith(md(`http://site.test${p}`), 403, "blocked_target");
  assert.equal(fx.hits.filter((h) => h.path === "/secret").length, 0, "the private target was never reached");
});

test("SSRF on every browser request: subresources, fetch, iframes, redirects of subresources and WebSockets never reach private space", { skip: chromiumSkip }, async () => {
  const before = fx.hits.length;
  fx.routes.set("site.test/img-redirect.png", redirect("http://rebind.test/secret.png"));
  fx.routes.set("/secret.png", (_q, s) => void s.end("x"));
  fx.routes.set("/secret.js", (_q, s) => void s.end("document.title='pwned'"));
  fx.routes.set("/direct", (_q, s) => void s.end("direct"));
  fx.routes.set("site.test/ok.css", (_q, s) => {
    s.writeHead(200, { "content-type": "text/css" });
    s.end("body{color:#111}");
  });
  fx.routes.set(
    "site.test/subs",
    html(
      `<h1>Subresources</h1><p>${"Text so the page has a body. ".repeat(20)}</p>
      <img src="http://169.254.169.254/latest/meta-data/">
      <img src="http://rebind.test/secret.png">
      <img src="/img-redirect.png">
      <iframe src="http://meta.test/"></iframe>
      <iframe src="http://rebind.test/secret"></iframe>
      <script src="http://rebind.test/secret.js"></script>
      <script>
        fetch("http://127.0.0.1:${fx.port}/direct").catch(() => {});
        fetch("http://rebind.test/direct").catch(() => {});
        fetch("http://[::1]/direct").catch(() => {});
        try { new WebSocket("ws://site.test/ws"); } catch {}
        try { new WebSocket("ws://127.0.0.1:${fx.port}/ws"); } catch {}
        navigator.sendBeacon && navigator.sendBeacon("/beacon", "x");
      </script>`,
      `<link rel="stylesheet" href="/ok.css"><link rel="stylesheet" href="http://[fd00:ec2::254]/x.css">`,
    ),
  );
  const r = await md("http://site.test/subs", 500);
  assert.equal(r.status, 200);
  assert.notEqual(r.title, "pwned");
  assert.ok(r.stats.blocked >= 6, `blocked ${r.stats.blocked}`);
  const reached = fx.hits.slice(before).map((h) => `${h.host}${h.path}`);
  assert.ok(reached.includes("site.test/ok.css"), "public subresources still load");
  for (const bad of ["/secret.png", "/secret.js", "/secret", "/direct", "/ws", "/beacon"]) {
    assert.ok(!reached.some((x) => x.endsWith(bad)), `${bad} must not be reached: ${reached.join(" ")}`);
  }
});

test("redirects: at most 2 for the main document, each checked; the final URL is reported", { skip: chromiumSkip }, async () => {
  fx.routes.set("site.test/h1", redirect("/h2", 301));
  fx.routes.set("site.test/h2", redirect("http://other.test/h3", 307));
  fx.routes.set("other.test/h3", redirect("/final", 302));
  fx.routes.set("other.test/final", html("<p>the end of the chain</p>", "<title>Final</title>"));
  const two = await md("http://site.test/h2");
  assert.equal(two.finalUrl, "http://other.test/final");
  assert.equal(two.title, "Final");
  await rejectsWith(md("http://site.test/h1"), 508, "too_many_redirects");
});

test("robots.txt for x429-render is respected, for the first URL and for a redirect target", { skip: chromiumSkip }, async () => {
  fx.routes.set("other.test/robots.txt", (_q, s) => {
    s.writeHead(200, { "content-type": "text/plain" });
    s.end("User-agent: x429-render\nDisallow: /private\n\nUser-agent: *\nDisallow: /\n");
  });
  fx.routes.set("other.test/private/page", html("<p>private</p>"));
  fx.routes.set("other.test/open", html("<p>open to x429-render</p>"));
  fx.routes.set("site.test/to-private-robots", redirect("http://other.test/private/page"));
  // a renderer of its own: other.test's robots.txt (none) is cached by the earlier tests
  const fresh = make();
  try {
    await rejectsWith(md("http://other.test/private/page", 0, fresh), 403, "robots_disallowed");
    await rejectsWith(md("http://site.test/to-private-robots", 0, fresh), 403, "robots_disallowed");
  } finally {
    await fresh.close();
  }
  const open = await md("http://other.test/open");
  assert.match(open.markdown, /open to x429-render/, "our group allows it even though * does not");
  assert.equal(fx.hits.filter((h) => h.host === "other.test" && h.path === "/private/page").length, 0);
});

test("timeout: a hanging subresource still renders; a page that never yields is cut at the hard timeout", { skip: chromiumSkip }, async () => {
  fx.routes.set("site.test/never", () => {
    // never answers
  });
  fx.routes.set("site.test/hangs", html(`<article><h1>Hangs</h1><p>${"Content that arrived before the hang. ".repeat(10)}</p><img src="/never"></article>`, "<title>Hangs</title>"));
  const quick = make({ timeoutMs: 6000 });
  try {
    const t0 = Date.now();
    const r = await md("http://site.test/hangs", 0, quick);
    assert.match(r.markdown, /Content that arrived before the hang/);
    assert.ok(Date.now() - t0 < 6000, "answered inside the timeout");

    fx.routes.set("site.test/spin", html(`<p>spin</p><script>setTimeout(() => { for (;;) {} }, 50)</script>`));
    const t1 = Date.now();
    await rejectsWith(md("http://site.test/spin", 500, quick), 504, "render_timeout");
    const took = Date.now() - t1;
    assert.ok(took >= 5900 && took < 8000, `cut at the timeout (${took} ms)`);
    const after = await md("http://site.test/hangs", 0, quick);
    assert.match(after.markdown, /Hangs/, "the browser still renders afterwards");
  } finally {
    await quick.close();
  }
});

test("budget: requests past the 5 MB-style response budget are aborted; a main document over it is refused", { skip: chromiumSkip }, async () => {
  const blob = (n: number) => (_q: unknown, s: import("node:http").ServerResponse) => {
    s.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    s.end(Buffer.alloc(150_000, n));
  };
  for (let i = 1; i <= 6; i++) fx.routes.set(`site.test/blob${i}.png`, blob(i));
  fx.routes.set("site.test/heavy", html(`<h1>Heavy</h1><p>${"Six large images follow. ".repeat(20)}</p>${[1, 2, 3, 4, 5, 6].map((i) => `<img src="/blob${i}.png">`).join("")}<script>addEventListener("load", () => fetch("/late.js").catch(() => {}))</script>`));
  fx.routes.set("site.test/late.js", (_q, s) => void s.end("1"));
  fx.routes.set("site.test/huge", (_q, s) => {
    s.writeHead(200, { "content-type": "text/html" });
    s.end(`<p>${"x".repeat(500_000)}</p>`);
  });
  const tight = make({ maxBytes: 400_000 });
  try {
    const before = fx.hits.length;
    const r = await md("http://site.test/heavy", 0, tight);
    assert.equal(r.stats.budgetHit, true);
    assert.ok(r.stats.bytes <= 400_000, `fetched ${r.stats.bytes}`);
    // images already in flight were cut when the budget ran out; a request after that is never sent
    assert.ok(r.stats.aborted >= 1);
    assert.equal(fx.hits.slice(before).filter((h) => h.path === "/late.js").length, 0, "no request once the budget is spent");
    assert.match(r.markdown, /Heavy/, "the page itself still renders");
    await rejectsWith(md("http://site.test/huge", 0, tight), 413, "too_large");
  } finally {
    await tight.close();
  }
});

test("limits: media and fonts are blocked, a PDF is refused, POST from the page is not sent", { skip: chromiumSkip }, async () => {
  const before = fx.hits.length;
  fx.routes.set("site.test/font.woff2", (_q, s) => void s.end("font"));
  fx.routes.set("site.test/clip.mp4", (_q, s) => void s.end("video"));
  fx.routes.set("site.test/post", (_q, s) => void s.end("posted"));
  fx.routes.set("site.test/media", html(`<h1>Media</h1><video src="/clip.mp4" autoplay muted></video><style>@font-face{font-family:X;src:url(/font.woff2)}body{font-family:X}</style><p>text</p><script>fetch("/post",{method:"POST",body:"x"}).catch(()=>{})</script>`));
  await md("http://site.test/media", 300);
  const reached = fx.hits.slice(before).map((h) => h.path);
  for (const p of ["/font.woff2", "/clip.mp4", "/post"]) assert.ok(!reached.includes(p), `${p} must not be fetched`);
  fx.routes.set("site.test/file.pdf", (_q, s) => {
    s.writeHead(200, { "content-type": "application/pdf" });
    s.end("%PDF-1.4");
  });
  await rejectsWith(md("http://site.test/file.pdf"), 415, "unsupported_content_type");
});

test("a fresh context per render: cookies set by one render are not sent by the next", { skip: chromiumSkip }, async () => {
  fx.routes.set("site.test/set-cookie", (_q, s) => {
    s.writeHead(200, { "content-type": "text/html", "set-cookie": "session=abc123; Path=/" });
    s.end("<p>cookie set</p><script>localStorage.setItem('k','v')</script>");
  });
  fx.routes.set("site.test/echo", html(`<p id="o"></p><script>document.getElementById("o").textContent = "storage=" + localStorage.getItem("k") + " cookie=" + document.cookie</script>`));
  await md("http://site.test/set-cookie");
  const r = await md("http://site.test/echo");
  assert.match(r.markdown, /storage=null cookie=$/m);
  const echo = fx.hits.filter((h) => h.path === "/echo").pop()!;
  assert.equal(echo.cookie, "");
});
