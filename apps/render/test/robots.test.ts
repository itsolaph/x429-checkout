// robots.txt: parsing and matching (RFC 9309), and fetching with a 10-minute cache that allows on errors.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { allowedBy, parseRobots, Robots, rulesFor } from "../src/robots.ts";
import { redirect, startFixture, testGuard, type Fixture } from "./fixture.ts";

let fx: Fixture;
before(async () => {
  fx = await startFixture();
});
after(() => fx.close());

const TXT = `
# comments are ignored
User-agent: *
Disallow: /

User-agent: Googlebot
User-agent: x429-render
Disallow: /private
Allow: /private/open
Disallow: /*.pdf$
Disallow: /search?

User-agent: other
Allow: /
`;

test("parse and match: our group over *, longest rule wins, allow on a tie, * and $ patterns", () => {
  const groups = parseRobots(TXT);
  assert.equal(groups.length, 3);
  const mine = rulesFor(groups, "x429-render");
  const ok = (p: string) => allowedBy(mine, p);
  assert.equal(ok("/"), true, "our group does not disallow /");
  assert.equal(ok("/private"), false);
  assert.equal(ok("/private/x"), false);
  assert.equal(ok("/private/open/page"), true, "the longer Allow wins");
  assert.equal(ok("/file.pdf"), false);
  assert.equal(ok("/file.pdf?x=1"), true, "$ anchors the end");
  assert.equal(ok("/search?q=1"), false);
  assert.equal(ok("/robots.txt"), true);

  const star = rulesFor(groups, "someone-else");
  assert.equal(allowedBy(star, "/anything"), false, "others fall back to *");
  assert.equal(allowedBy(rulesFor(parseRobots("User-agent: X429-Render/1.0\nDisallow: /a"), "x429-render"), "/a"), false, "the token matches case-insensitively, without a version");
  assert.equal(allowedBy(rulesFor(parseRobots("User-agent: *\nDisallow:"), "x429-render"), "/a"), true, "an empty Disallow allows");
  assert.equal(allowedBy(rulesFor(parseRobots(""), "x429-render"), "/a"), true);
  const tie = rulesFor(parseRobots("User-agent: *\nDisallow: /page\nAllow: /page"), "x429-render");
  assert.equal(allowedBy(tie, "/page"), true, "allow wins a tie");
});

test("fetch: deny and allow per origin, cached for 10 minutes; 4xx, 5xx, errors and timeouts allow", async () => {
  let clock = 1_000_000;
  const robots = new Robots({ guard: testGuard(fx.port), token: "x429-render", userAgent: "test x429-render", now: () => clock, timeoutMs: 1000 });
  let served = 0;
  fx.routes.set("site.test/robots.txt", (_req, res) => {
    served++;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("User-agent: x429-render\nDisallow: /private\n");
  });
  assert.equal(await robots.allowed("http://site.test/private/page"), false);
  assert.equal(await robots.allowed("http://site.test/public"), true);
  assert.equal(served, 1, "one fetch per origin");
  clock += 9 * 60_000;
  await robots.allowed("http://site.test/x");
  assert.equal(served, 1, "still cached after 9 minutes");
  clock += 2 * 60_000;
  await robots.allowed("http://site.test/x");
  assert.equal(served, 2, "fetched again after 10 minutes");

  // other.test: 500, then a 404 under another scheme's origin, a hanging robots, and redirects to a deny
  fx.routes.set("other.test/robots.txt", (_req, res) => {
    res.writeHead(500);
    res.end();
  });
  assert.equal(await robots.allowed("http://other.test/private"), true, "5xx allows");
  assert.equal(await robots.allowed("https://nowhere.test/private"), true, "a host that does not resolve allows (the guard refuses it anyway)");

  const r2 = new Robots({ guard: testGuard(fx.port), token: "x429-render", userAgent: "t", timeoutMs: 500 });
  fx.routes.set("site.test/robots.txt", () => {
    // never answers
  });
  const t0 = Date.now();
  assert.equal(await r2.allowed("http://site.test/private"), true, "a timeout allows");
  assert.ok(Date.now() - t0 < 3000);

  const r3 = new Robots({ guard: testGuard(fx.port), token: "x429-render", userAgent: "t" });
  fx.routes.set("other.test/robots.txt", redirect("http://site.test/real-robots.txt"));
  fx.routes.set("site.test/real-robots.txt", (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("User-agent: *\nDisallow: /\n");
  });
  assert.equal(await r3.allowed("http://other.test/page"), false, "robots.txt redirects are followed");
  fx.routes.set("site.test/robots.txt", (_req, res) => {
    res.writeHead(404);
    res.end();
  });
  assert.equal(await r3.allowed("http://site.test/private"), true, "no robots.txt (404) allows");
});
