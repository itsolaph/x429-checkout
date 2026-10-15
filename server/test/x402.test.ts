import { strict as assert } from "node:assert";
import { test } from "node:test";
import { verifyTypedData, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_USDC, transferWithAuthorizationTypedData, transferWithAuthorizationTypes, usdcDomain } from "../src/protocol.ts";
import {
  buildPaymentHeader,
  decodeHeader,
  readPayment,
  v1PaymentRequired,
  v2PaymentRequired,
  type RequirementsInput,
} from "../src/x402.ts";

// anvil's well-known test key #0
const payer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const payTo = "0x51CE89cdD6a5E4b48a23Ad3a4aA24457BB3d3e0e" as Address;

const input: RequirementsInput = {
  chainId: 8453,
  asset: BASE_USDC,
  payTo,
  amount: 37_080n,
  resourceUrl: "http://localhost/skip?queue=1&target=1",
  description: "skip",
  maxTimeoutSeconds: 120,
  quote: { cost: "30900" },
};

async function signed(value = 37_080n) {
  const authorization = {
    from: payer.address,
    to: payTo,
    value,
    validAfter: 0n,
    validBefore: 2_000_000_000n,
    nonce: `0x${"ab".repeat(32)}` as const,
  };
  const signature = await payer.signTypedData(transferWithAuthorizationTypedData({ chainId: 8453, usdc: BASE_USDC, ...authorization }));
  return { signature, authorization };
}

test("v1 402 body follows the spec shape", () => {
  const body = v1PaymentRequired(input, "payment required");
  assert.equal(body.x402Version, 1);
  const a = body.accepts[0]!;
  assert.equal(a.scheme, "exact");
  assert.equal(a.network, "base");
  assert.equal(a.maxAmountRequired, "37080");
  assert.equal(a.payTo, payTo);
  assert.deepEqual({ name: a.extra.name, version: a.extra.version }, { name: "USD Coin", version: "2" });
});

test("v2 PAYMENT-REQUIRED uses CAIP-2 and amount", () => {
  const pr = v2PaymentRequired(input, "payment required");
  assert.equal(pr.x402Version, 2);
  assert.equal(pr.accepts[0]!.network, "eip155:8453");
  assert.equal(pr.accepts[0]!.amount, "37080");
  assert.equal(pr.resource.url, input.resourceUrl);
});

test("X-PAYMENT (v1) round trip keeps a valid EIP-3009 signature", async () => {
  const payload = await signed();
  const header = buildPaymentHeader(1, 8453, payload);
  const decoded = decodeHeader(header) as Record<string, unknown>;
  assert.equal(decoded.x402Version, 1);
  assert.equal(decoded.network, "base");
  const p = readPayment({ "x-payment": header });
  assert.ok(p && !("error" in p));
  assert.equal(p.version, 1);
  assert.equal(p.payload.authorization.value, 37_080n);
  const ok = await verifyTypedData({
    address: payer.address,
    domain: usdcDomain(8453, BASE_USDC),
    types: transferWithAuthorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: p.payload.authorization,
    signature: p.payload.signature,
  });
  assert.equal(ok, true);
});

test("PAYMENT-SIGNATURE (v2) wins over X-PAYMENT and carries `accepted`", async () => {
  const payload = await signed();
  const accepted = v2PaymentRequired(input, "").accepts[0];
  const p = readPayment({
    "payment-signature": buildPaymentHeader(2, 8453, payload, accepted, { url: input.resourceUrl }),
    "x-payment": buildPaymentHeader(1, 8453, payload),
  });
  assert.ok(p && !("error" in p));
  assert.equal(p.version, 2);
  assert.equal(p.network, "eip155:8453");
  assert.equal(p.accepted?.payTo, payTo);
});

test("malformed payment headers are rejected with a reason", () => {
  assert.equal(readPayment({}), undefined);
  assert.deepEqual((readPayment({ "x-payment": "%%%" }) as { error: string }).error, "invalid_payload");
  const v3 = Buffer.from(JSON.stringify({ x402Version: 3 })).toString("base64");
  assert.equal((readPayment({ "x-payment": v3 }) as { error: string }).error, "invalid_x402_version");
  const noSig = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base", payload: {} })).toString("base64");
  assert.equal((readPayment({ "x-payment": noSig }) as { error: string }).error, "invalid_payload");
});
