// The SSRF guard without a browser: the address matrix, the URL policy, DNS answers that point
// inside (the rebinding shape), and redirects followed hop by hop.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { BlockedError, BudgetError, isPublicAddress } from "../src/guard.ts";
import { html, redirect, startFixture, testGuard, type Fixture } from "./fixture.ts";

let fx: Fixture;
before(async () => {
  fx = await startFixture();
});
after(() => fx.close());

test("address matrix: loopback, RFC 1918, CGNAT, link-local, ULA, metadata, mapped and reserved space are not public", () => {
  const refused = [
    "127.0.0.1", "127.1.2.3", "0.0.0.0", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "100.64.0.1", "100.100.100.200", "169.254.169.254", "169.254.0.1", "192.0.0.170", "192.0.2.1", "198.18.0.1", "198.51.100.7",
    "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::1", "::", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::127.0.0.1", "64:ff9b::7f00:1",
    "fc00::1", "fd00:ec2::254", "fe80::1", "fec0::1", "ff02::1", "2001:db8::1", "2002:7f00:1::1", "2001::1", "100::1",
    "not an ip", "",
  ];
  for (const ip of refused) assert.equal(isPublicAddress(ip), false, `${ip} must be refused`);
  const allowed = ["93.184.215.14", "1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "192.169.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001::1"];
  for (const ip of allowed) assert.equal(isPublicAddress(ip), true, `${ip} must be allowed`);
});

test("URL policy: http and https on 80 or 443 only, no credentials, no private literals in any spelling", async () => {
  const g = testGuard();
  const refused: [string, string][] = [
    ["ftp://site.test/", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["gopher://site.test/", "scheme"],
    ["http://site.test:8080/", "port"],
    ["https://site.test:22/", "port"],
    ["http://user:pw@site.test/", "credentials"],
    ["http://localhost/", "private_address"],
    ["http://api.localhost/", "private_address"],
    ["http://127.0.0.1/", "private_address"],
    ["http://2130706433/", "private_address"], // 127.0.0.1 as one decimal number
    ["http://0x7f000001/", "private_address"],
    ["http://0177.0.0.1/", "private_address"],
    ["http://127.1/", "private_address"],
    ["http://[::1]/", "private_address"],
    ["http://[::ffff:127.0.0.1]/", "private_address"],
    ["http://[::ffff:a9fe:a9fe]/", "private_address"], // 169.254.169.254
    ["http://169.254.169.254/latest/meta-data/", "private_address"],
    ["http://[fd00:ec2::254]/", "private_address"],
    ["http://10.0.0.1/", "private_address"],
    ["not a url", "invalid_url"],
  ];
  for (const [url, reason] of refused) {
    await assert.rejects(g.check(url), (e: unknown) => e instanceof BlockedError && e.reason === reason, `${url} → ${reason}`);
  }
  const ok = await g.check("https://site.test/a?b=1");
  assert.equal(ok.address, "93.184.215.14");
  assert.equal(ok.port, 443);
  assert.equal((await g.check("http://site.test:80/")).port, 80);
  assert.equal((await g.check("https://site.test:443/")).port, 443);
});

test("DNS: a name that resolves to loopback, metadata, ULA, or to one private address among public ones is refused", async () => {
  const g = testGuard();
  for (const host of ["rebind.test", "meta.test", "mixed.test", "v6.test"]) {
    await assert.rejects(g.check(`http://${host}/`), (e: unknown) => e instanceof BlockedError && e.reason === "private_address", host);
  }
  await assert.rejects(g.check("http://nowhere.test/"), (e: unknown) => e instanceof BlockedError && e.reason === "dns");
});

test("fetch: redirects are followed hop by hop and a hop into private space is refused before it is requested", async () => {
  const g = testGuard(fx.port);
  fx.routes.set("site.test/ok", html("<p>ok</p>"));
  fx.routes.set("site.test/r1", redirect("http://other.test/r2"));
  fx.routes.set("other.test/r2", redirect("/ok"));
  fx.routes.set("other.test/ok", html("<p>other ok</p>"));
  fx.routes.set("site.test/to-loopback", redirect("http://rebind.test/secret"));
  fx.routes.set("site.test/to-literal", redirect("http://127.0.0.1/secret"));
  fx.routes.set("site.test/to-metadata", redirect("http://169.254.169.254/latest/meta-data/"));
  fx.routes.set("/secret", html("<p>secret</p>"));

  const r = await g.fetch("http://site.test/r1", { maxBytes: 1e6, maxRedirects: 3 });
  assert.equal(r.status, 200);
  assert.equal(r.url, "http://other.test/ok");
  assert.equal(r.redirects, 2);
  assert.match(r.body.toString(), /other ok/);

  // without redirects allowed, the 3xx itself comes back (the renderer handles it)
  const raw = await g.fetch("http://site.test/r1", { maxBytes: 1e6 });
  assert.equal(raw.status, 302);
  assert.equal(raw.headers.location, "http://other.test/r2");

  for (const p of ["/to-loopback", "/to-literal", "/to-metadata"]) {
    await assert.rejects(g.fetch(`http://site.test${p}`, { maxBytes: 1e6, maxRedirects: 3 }), BlockedError, p);
  }
  assert.equal(fx.hits.filter((h) => h.path === "/secret").length, 0, "no private target was ever reached");
});

test("fetch: the body budget is enforced on decoded bytes, declared or streamed", async () => {
  const g = testGuard(fx.port);
  fx.routes.set("site.test/big", (_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(300_000) });
    res.end(Buffer.alloc(300_000, 1));
  });
  fx.routes.set("site.test/chunked", (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    for (let i = 0; i < 30; i++) res.write(Buffer.alloc(10_000, 65));
    res.end();
  });
  fx.routes.set("site.test/gzip-bomb", async (_req, res) => {
    const { gzipSync } = await import("node:zlib");
    res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
    res.end(gzipSync(Buffer.alloc(2_000_000, 0))); // ~2 KB on the wire, 2 MB decoded
  });
  await assert.rejects(g.fetch("http://site.test/big", { maxBytes: 100_000 }), BudgetError);
  await assert.rejects(g.fetch("http://site.test/chunked", { maxBytes: 100_000 }), BudgetError);
  await assert.rejects(g.fetch("http://site.test/gzip-bomb", { maxBytes: 100_000 }), BudgetError);
  const fine = await g.fetch("http://site.test/chunked", { maxBytes: 1_000_000 });
  assert.equal(fine.body.length, 300_000);
});
