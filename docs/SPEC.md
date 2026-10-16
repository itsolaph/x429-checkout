# x429 v0.3: paid priority over x402, on Base (PayBox plugin edition)

## 0. v0.3: x402 is the only user action

v0.3 keeps everything below (v0.2) and adds a user side that needs nothing but x402 payments, so it
runs through a PayBox plugin (which can return data or one x402 proposal, never ask for a
signature). Sections 3, 5 and 6 below describe the v0.2 paths, which still work.

**Identity.** The payer of an x402 `exact` payment is `authorization.from` of its EIP-3009
`TransferWithAuthorization`. The contract creates and moves tickets for that address.

**Join** = `POST /join`, body `{skipPrice?}` (USDC units, at most `X429_MAX_SKIP_PRICE`, default
0.1 USDC). Without a payment header: 402 with `amount` = the queue's `joinFee` (`maxAmountRequired`
in v1, at least 1 unit). With one: the operator calls `joinPaid(queueId, skipPrice, auth)`, which
pulls the authorization, creates a waiting ticket for `auth.from` at the tail, books `joinFee` as
operator fees and refunds the rest in the same transaction. Errors: `already_waiting` (409),
`queue_full` (409), `join_fee_not_covered` (402), plus every x402 verification error of §4.3. The
join fee goes to the operator: it pays the operator's gas for the join and makes queue spam cost
money, without new accounting (a refundable bond would lock the user's money and need a second
transaction to return it).

**Skip** = `POST /skip`, body `{target, owner?, skipPrice?}` (or the v0.2 query form). As §4, priced
for `owner` when given (the public payer address; never the token). The 402 `resource` is the plain
path for body requests.

**Redeem token.** Every successful paid response (join, skip) contains `token`: `x429_` followed
by 32 random bytes in base64url (43 characters). The server stores only its SHA-256, with the
ticket id and owner (`X429_DATA_DIR`, survives restarts). The token is a bearer credential for that
ticket; a paid response may be retried: the same payment (same `from` and nonce, signature valid,
inside its `validBefore`) answers 200 `replayed: true` with a fresh token for the same ticket, and
nothing is charged again.

**Use** = `POST /use {token, city?}`: 429 `{status: "waiting", position, etaSeconds, skipToFront}`
(with `Retry-After`) while waiting, 200 `{status: "served", result}` once served. The result is
built once; using the token again inside the admission window (`X429_ADMISSION_TTL_MS`, default
5 min) returns the same result. Afterwards 410 `expired`. `POST /ticket {token}` shows the status
without using it. One served ticket is still one request.

**Payouts.** After each skip the server queues the passed owners and the operator calls
`payoutBatch(owners)` (at most 64): for each owner it sends `claimable[owner]` to that owner and
zeroes it. The function has no recipient parameter, so the operator decides only *when*, never
*where*. A transfer USDC refuses (blocklist) leaves the balance claimable and emits `PayoutFailed`.
A periodic sweep re-queues anyone with a claimable balance. `claim` / `claimWithSig` stay as the
fallback.

**Reads for the plugin.** `GET|POST /quote` (`{target?, owner?, token?}` → cost, `maxAmountRequired`
ceiling, `quoteExpiresAt`), `GET /queue` (positions, posted prices, cost to reach each, `joinFee`,
`serviceIntervalMs`), `GET /earnings/{address}` (earned, received, pending).

**Contract additions.** `joinFee(queueId)`, `setJoinFee(queueId, fee)` (operator, max 1 USDC),
`joinPaid`, `payout(owner)`, `payoutBatch(owners)`; events `JoinFeeSet`, `JoinPaid`, `PaidOut`,
`PayoutFailed`; refund reasons `AlreadyWaiting`, `BelowJoinFee` for front-run join payments, which
are applied or refunded in full exactly like front-run skips (§4.5). Descriptor `version` is "0.3"
and gains `use`, `payouts` and `gaslessJoin` (the v0.2 join, now `POST /join/signed`).

---

# v0.2 (unchanged, still supported)

x429 turns `429 Too Many Requests` into a price. A saturated API answers 429 with a descriptor of
an onchain queue. A client may wait for free, or pay to move ahead. Moving ahead costs the posted
skip price of **every ticket it passes**, paid to those tickets, plus an optional operator fee. The
API serves the queue strictly from the head. A served ticket redeems one request.

v0.2 runs on **Base mainnet** (`eip155:8453`) with **USDC** (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`,
6 decimals). Payments are **x402 `exact`** (EIP-3009 `transferWithAuthorization`). Joining and
claiming are EIP-712 signatures relayed by the operator. A user never needs ETH.

All amounts are USDC base units (6 decimals): `5000` = $0.005.
MUST, SHOULD and MAY are used as in RFC 2119.

Reference implementation: `contracts/src/X429Checkout.sol`, `server/src/`.

---

## 1. Roles

| Role | Holds | Does |
|---|---|---|
| **Operator** | an EOA with ETH on Base | creates the queue, relays joins/claims/skips (pays gas), serves the head, may set a fee ≤ 10% and withdraw its own fees |
| **Client** (agent) | a wallet with USDC, no ETH needed | joins (signature), pays to skip (x402), claims (signature), redeems a served ticket (signature) |
| **Contract** | all USDC in flight and owed | moves money and the queue atomically, credits compensation |

One contract serves **one operator**, fixed at deploy (`operator()` is immutable). The x402
`payTo` is the contract, so a payment can only ever be settled by that operator. The operator can
never move a client's USDC except as the client signed it: the EIP-3009 authorization fixes amount
and recipient (the contract), and the contract pays every passed ticket its own posted price and
refunds the rest to the payer.

## 2. The 429 response

```
HTTP/1.1 429 Too Many Requests
Content-Type: application/json; charset=utf-8
Retry-After: 18
X-429-Queue: 0x51CE89cdD6a5E4b48a23Ad3a4aA24457BB3d3e0e/1
```

```json
{
  "error": "too_many_requests",
  "message": "Busy. You are #7 in line; skipping to the front costs $0.0309 right now, paid to the 6 agents you pass.",
  "x429": {
    "version": "0.2",
    "network": "eip155:8453",
    "chainId": 8453,
    "contract": "0x51CE89cdD6a5E4b48a23Ad3a4aA24457BB3d3e0e",
    "queueId": 1,
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "currency": { "symbol": "USDC", "decimals": 6 },
    "queueLength": 6,
    "position": 7,
    "serviceIntervalMs": 4000,
    "admissionRoundMs": 15000,
    "admissionTtlMs": 60000,
    "suggestedSkipPrice": "5000",
    "feeBps": 300,
    "ticket": null,
    "skip": {
      "method": "POST",
      "url": "https://api.example.com/skip?queue=1&target=1",
      "payment": "x402 exact (EIP-3009 USDC on Base); v1 X-PAYMENT or v2 PAYMENT-SIGNATURE",
      "toFront": {
        "targetPosition": 1, "passes": 6,
        "compensation": "30000", "fee": "900", "cost": "30900",
        "maxAmountRequired": "37080", "costUsd": "$0.0309"
      },
      "quotes": "https://api.example.com/queue/1"
    },
    "join": {
      "method": "POST",
      "url": "https://api.example.com/join",
      "typedData": "https://api.example.com/join/typed-data?owner=<address>&skipPrice=<units>",
      "gasless": true
    },
    "redeem": {
      "headers": ["x-429-ticket", "x-429-signature"],
      "message": "x429:v2:8453:0x51ce89cdd6a5e4b48a23ad3a4aa24457bb3d3e0e:<ticketId>",
      "scheme": "EIP-191 personal_sign by the ticket owner"
    },
    "mcp": "https://api.example.com/mcp"
  }
}
```

- `position`: where a request without a ticket would join (`queueLength + 1`), or the caller's
  ticket position when it sent ticket headers.
- `ticket`: `null`, or `{id, status: "waiting" | "serving", position}` for a request with ticket headers.
- `skip.toFront`: the price to reach #1 right now for a newcomer. `GET /queue/{id}` lists a quote for
  every target position (and for the caller's own ticket with `?owner=`).
- `Retry-After`: expected wait in seconds at that position. Always ≥ 1.
- `GET /x429` returns the bare `x429` object with status 200.

## 3. Joining (free, gasless)

1. `GET /join/typed-data?owner=<address>&skipPrice=<units>` returns `{typedData, submit}`.
2. The client signs `typedData` (EIP-712, `eth_signTypedData_v4` shape).
3. `POST /join` with `{...submit, signature}`. The operator relays `joinWithSig` and pays gas.

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
  name = "x429 Checkout", version = "1", chainId = 8453, verifyingContract = <contract>
Join(address owner,uint32 queueId,uint128 skipPrice,bytes32 nonce,uint256 deadline)
```

Only the operator can relay a join (`joinWithSig` is operator-only and there is no direct `join`).
That is the spam control: joining is free for the client, so a join anyone could send would let a
spammer fill the queue to `maxLength` and lock newcomers out. The server rate-limits relayed joins per
client IP (`X429_JOINS_PER_MINUTE`, default 30) and answers 429 `too_many_joins` above it.

`skipPrice` is what the ticket is paid each time it is passed. Nonces are random 32-byte values,
single use, per owner (like EIP-3009), so concurrent signatures never block each other. An owner
holds at most **one waiting ticket per queue**.

## 4. Skipping (paid, x402)

### 4.1 Payment required

`POST /skip?queue=<id>&target=<position>[&skipPrice=<units>][&owner=<address>]` without payment
returns **402** with both x402 versions:

- **v1**: JSON body `{x402Version: 1, error, accepts: [PaymentRequirements]}`.
- **v2**: header `PAYMENT-REQUIRED: base64(PaymentRequired)`.

```json
{
  "x402Version": 1,
  "error": "X-PAYMENT (v1) or PAYMENT-SIGNATURE (v2) header is required",
  "accepts": [{
    "scheme": "exact",
    "network": "base",
    "maxAmountRequired": "37080",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0x51CE89cdD6a5E4b48a23Ad3a4aA24457BB3d3e0e",
    "resource": "https://api.example.com/skip?queue=1&target=1",
    "description": "x429: move from #7 to #1 in queue 1. Costs $0.0309 now, paid to the 6 agents you pass; up to $0.03708 is authorized and the unused part is refunded in the same transaction.",
    "mimeType": "application/json",
    "outputSchema": null,
    "maxTimeoutSeconds": 120,
    "extra": {
      "name": "USD Coin", "version": "2", "assetTransferMethod": "eip3009",
      "x429": {
        "queueId": 1, "fromPosition": 7, "targetPosition": 1, "passes": 6,
        "compensation": "30000", "fee": "900", "cost": "30900", "slippageBps": 2000,
        "quotedAt": 1792034465, "quoteExpiresAt": 1792035065,
        "refund": "unused amount is refunded to the payer in the same transaction"
      }
    }
  }],
  "quote": { "...": "same numbers, plus the list of tickets that would be passed" }
}
```

The v2 object carries the same requirement with `network: "eip155:8453"` and `amount` instead of
`maxAmountRequired`, plus `resource: {url, description, mimeType}`.

- `payTo` is the queue contract. The money goes straight into the contract, never to the operator.
- `maxAmountRequired` (v2 `amount`) = quoted cost × (1 + `slippageBps`/10 000). It is a **ceiling**.
  The payer is charged the actual cost at settlement; the rest is refunded in the same transaction.
- `maxTimeoutSeconds` bounds how long the signed authorization stays valid after signing.
- `extra.x429.quoteExpiresAt` is how long the server honours the ceiling of this quote (default
  10 minutes, enough for a passkey approval). v2 clients echo it in `accepted`; the server
  refuses an expired one with `quote_expired`.
- The quote assumes a newcomer unless `owner` is given. The payer (`authorization.from`) is who
  pays and who moves, whatever the hint.

### 4.2 Paying

The client repeats the same request with `X-PAYMENT: base64(PaymentPayload v1)` or
`PAYMENT-SIGNATURE: base64(PaymentPayload v2)`. The payload is the x402 `exact` EVM payload:

```json
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "base",
  "payload": {
    "signature": "0x…65 bytes",
    "authorization": {
      "from": "0xPayer", "to": "<contract>", "value": "37080",
      "validAfter": "1792033865", "validBefore": "1792034585", "nonce": "0x…32 bytes"
    }
  }
}
```

signed as EIP-712 `TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)`
in USDC's domain (`name "USD Coin"`, `version "2"`, chain 8453, USDC address).

### 4.3 Verification (server, before any transaction)

There is no third-party facilitator. The server checks, in order, and answers the first failure:

| Check | Status | `error` |
|---|---|---|
| header decodes, payload well-formed | 400 | `invalid_payload`, `invalid_x402_version` |
| `scheme == "exact"`, network is Base | 400 | `invalid_scheme`, `invalid_network` |
| v2 `accepted.asset/payTo` match | 400 | `invalid_payment_requirements` |
| v2 `accepted.extra.x429.quoteExpiresAt` not passed | 402 | `quote_expired` |
| `authorization.to == contract` | 402 | `invalid_exact_evm_payload_recipient_mismatch` |
| EIP-3009 signature recovers `from` | 402 | `invalid_exact_evm_payload_signature` |
| `validBefore > now + 2 s` (chain time) | 402 | `invalid_exact_evm_payload_authorization_valid_before` |
| `validAfter < now + 1 s` | 402 | `invalid_exact_evm_payload_authorization_valid_after` |
| not already settled by the contract | 402 | `payment_already_settled` |
| nonce unused at USDC, or a verified front-run (§4.5) | 402 | `invalid_transaction_state` |
| payer balance ≥ `value` | 402 | `insufficient_funds` |
| the skip is possible | 409 | `nothing_to_pass`, `too_many_passes`, `queue_full`, `invalid_target` |
| actual cost now ≤ `value` | 402 | `price_moved` (with `cost` and `signed`) |

Every 402 carries fresh requirements (v1 body, v2 header) and a failure `X-PAYMENT-RESPONSE` /
`PAYMENT-RESPONSE` `{success: false, errorReason, transaction: "", network, payer}`.
Nothing moves on any of these: the authorization was not submitted and stays usable or expires.

### 4.4 Settlement

The operator calls

```solidity
skip(uint32 queueId, uint32 targetPosition, uint128 newTicketSkipPrice, Authorization auth)
```

after an `eth_call` simulation. In one transaction the contract:

1. marks `(from, nonce)` settled (replay protection independent of USDC);
2. finds the payer's waiting ticket, or plans a new one at the tail (join + skip);
3. computes `passes = from − target`, `compensation = Σ posted prices of the tickets passed`,
   `fee = compensation × feeBps / 10 000` (rounded down), `cost = compensation + fee`;
4. reverts with `CostExceedsPayment(cost, value)` if `cost > value`, or `NothingToPass`,
   `TooManyPasses`, `QueueFull`; otherwise calls `USDC.transferWithAuthorization(from, this, value, …)`;
5. joins the payer if needed, credits each passed ticket's owner `claimable += price`, moves the
   ticket in front of the furthest one passed, accrues the fee;
6. pushes `value − cost` back to the payer. If USDC refuses the push, the refund is credited to
   the payer's `claimable` instead.

A revert costs the operator gas but moves nothing, and the server turns it into the matching 402.
On success the server answers **200**:

```json
{
  "ok": true, "ticketId": "7", "owner": "0xPayer", "fromPosition": 7, "position": 1, "passes": 6,
  "compensation": "30000", "fee": "900", "cost": "30900", "refund": "6180",
  "frontRun": false, "refundedInFull": false, "ticketSkipPrice": "2000",
  "passed": [{ "ticketId": "1", "owner": "0x…", "amount": "3000" }, "…"],
  "txHash": "0x…", "explorerUrl": "https://basescan.org/tx/0x…",
  "message": "You are now #1. Paid 6 agent(s) 30000 units in total, fee 900, refunded 6180."
}
```

with `X-PAYMENT-RESPONSE` (v1) or `PAYMENT-RESPONSE` (v2) = `base64({success: true, transaction, network, payer})`.

**Why refund in the same transaction (not a claimable credit).** The payer is an agent wallet with
no ETH. A credit would need a second, relayed claim to get back money the payer never meant to
spend. A push in the same transaction leaves the payer whole immediately. The push cannot be used to
block the skip: USDC has no receive hooks, and if the transfer fails (e.g. a blocklisted payer) the
contract credits `claimable` instead of reverting.

### 4.5 Front-run authorizations

`transferWithAuthorization` is public. Anyone who sees an `X-PAYMENT` header can submit it straight
to USDC: the USDC lands in the contract, the nonce is used, and no queue update happens.

- The server sees `USDC.authorizationState(from, nonce) == true` while the contract has not settled
  it. It then looks for USDC's `AuthorizationUsed(from, nonce)` log (back to the deploy block) and
  requires the very next log to be `Transfer(from → contract, value)` from USDC (FiatToken emits the
  two back to back). A nonce burned by `cancelAuthorization`, or used for a different transfer, fails
  with `invalid_transaction_state`, even if the same transaction paid the contract through another
  nonce. The authorization's time window is not checked here: the money already moved.
- The contract, in `skip`, also sees the nonce used. It verifies the EIP-3009 signature over the
  exact authorization (`to` = itself) and that its USDC balance exceeds everything it owes by at
  least `value`. Then it **applies** the skip, or, if the skip is no longer possible (price moved,
  nothing to pass, queue full), **refunds the whole value** to the payer and emits
  `PaymentRefunded(from, nonce, value, reason)`. Nothing gets stuck either way.

The balance check stops anyone from settling an authorization that never paid. It cannot tell
which stray USDC belongs to whom, which is why the log check in the server matters (§10).

## 5. Serving and redemption

The operator serves **only from the head**, with `serve(queueId, 1)`, when:

1. the queue is not empty and no serve is in flight,
2. the service is free (`now ≥ busyUntil`; each admission sets `busyUntil = now + serviceIntervalMs`),
3. the head has waited at least `admissionRoundMs` since the server first saw it (the **admission
   round**: a fresh joiner is not served before one round passes, so others can still bid ahead).

The serve receipt's `Served` events create in-memory admissions valid for `admissionTtlMs`.
The owner redeems by repeating the original request with

```
X-429-Ticket: <ticketId>
X-429-Signature: <EIP-191 personal_sign of "x429:v2:<chainId>:<contract lowercase>:<ticketId>">
```

| Situation | Response |
|---|---|
| malformed id or signature | 403 `malformed_ticket` |
| admission used or expired | 403 `ticket_used_or_expired` |
| admitted, signature matches the owner | **200**, admission consumed |
| admitted, signature does not match | 403 `bad_signature` |
| unknown ticket / other queue | 403 `unknown_ticket` |
| waiting (valid signature) | 429 with `ticket {status: "waiting", position}` |
| served, serve receipt still processing | 429 with `ticket {status: "serving"}`, `Retry-After: 1` |
| served before this server started | 403 `not_admitted` |
| left | 403 `ticket_left` |

A request without ticket headers is admitted directly only when the queue is empty, no serve is in
flight and the service is free. Otherwise it gets the 429 of §2.

## 6. Claiming (gasless)

Passed tickets accrue `claimable[owner]` (pull payments). To withdraw:

1. `GET /claim/typed-data?owner=<address>[&recipient=<address>]` → `{claimable, typedData, submit}`
2. sign `Claim(address owner,address recipient,bytes32 nonce,uint256 deadline)` in the x429 domain
3. `POST /claim` with `{...submit, signature}` → `{amount, txHash}`

The whole balance goes to the signed `recipient`. A signature works once (`nonce_already_used`).
Anyone may relay a signed claim; owners with ETH may also call `claim(recipient)` directly.
`cancelNonce(nonce)` burns an unused nonce.

## 7. Contract interface

`contracts/src/X429Checkout.sol` (Solidity 0.8.30, no owner, no upgrade, no admin).

```solidity
constructor(IERC20 usdc, address operator);                             // one operator per contract, immutable

// operator only
function createQueue(uint32 maxLength, uint16 feeBps, string meta) returns (uint32 queueId); // maxLength ≤ 256; fee ≤ 1000 bps
function setFee(uint32 queueId, uint16 feeBps);                         // ≤ 1000 bps (10%)
function withdrawFees(uint32 queueId, address to) returns (uint256);    // only the queue's own fees
function serve(uint32 queueId, uint32 count) returns (uint32 served);   // from the head
function joinWithSig(address owner, uint32 queueId, uint128 skipPrice, bytes32 nonce, uint256 deadline, bytes signature)
    returns (uint64 ticketId);                                          // relays the owner's signed Join
function skip(uint32 queueId, uint32 targetPosition, uint128 newTicketSkipPrice, Authorization auth)
    returns (uint64 ticketId, uint256 cost, uint256 refund);

// clients
function leave(uint64 ticketId);
function claim(address recipient) returns (uint256);
function claimWithSig(address owner, address recipient, bytes32 nonce, uint256 deadline, bytes signature) returns (uint256);
function cancelNonce(bytes32 nonce);

// views
function queueInfo(uint32) view returns (Queue);   // operator, feeBps, length, maxLength, skips, head, tail, joined, served, totalCompensation, feesAccrued, meta
function getQueue(uint32 queueId, uint32 offset, uint32 limit) view returns (TicketView[]);  // serving order
function positionOf(uint64 ticketId) view returns (uint32);             // 1-based, 0 if not waiting
function quoteSkip(uint32 queueId, address owner, uint32 targetPosition) view
    returns (uint32 fromPosition, uint32 passes, uint256 compensation, uint256 fee);
function operator() view returns (address);
function usdc() view returns (address);
function tickets(uint64) view returns (owner, queueId, status, timesPassed, joinedAt, prev, next, skipPrice, earned, paid);
function activeTicket(uint32 queueId, address owner) view returns (uint64);
function claimable(address) view returns (uint256);
function paymentSettled(address from, bytes32 nonce) view returns (bool);
function nonceUsed(address owner, bytes32 nonce) view returns (bool);
function totalClaimable() view returns (uint256);
function totalFees() view returns (uint256);
```

Bounds: `MAX_PASSES = 64` per skip, `MAX_QUEUE_LENGTH = 256`, `MAX_FEE_BPS = 1000`.
Statuses: `0 None, 1 Waiting, 2 Served, 3 Left`.

**Events** (one for every state change): `QueueCreated`, `FeeSet`, `Joined`, `Passed`, `Skipped`,
`PaymentReceived(from, nonce, value, frontRun)`, `PaymentRefunded(from, nonce, value, reason)`,
`RefundCredited`, `Served`, `Left`, `Claimed`, `NonceUsed`, `FeesWithdrawn`.

**Invariants** (fuzzed in `contracts/test/X429Checkout.invariant.t.sol`):

- `USDC.balanceOf(contract) == totalClaimable + totalFees + in-flight front-run payments`;
- `totalClaimable == Σ claimable`, `totalFees == Σ feesAccrued`;
- a passed ticket is credited exactly its posted price; a payer is charged exactly
  `Σ prices + fee` and refunded `value − cost`;
- `Σ earned == Σ paid == Σ totalCompensation`;
- the linked list is consistent and `activeTicket` points at the owner's waiting ticket.

## 8. Agent interface (MCP)

`POST /mcp` is a stateless streamable-HTTP MCP server with the same actions as tools:
`x429_status`, `x429_quote`, `x429_join_typed_data`, `x429_join`, `x429_skip`,
`x429_claim_typed_data`, `x429_claim`, `x429_redeem`. Signing and paying always go through the
client's wallet (PayBox `request_wallet_sign`, `use_service` / `pay_x402`). See `docs/PAYBOX.md`.

## 9. Changes from v0.1

| v0.1 (Arc) | v0.2 (Base) |
|---|---|
| native USDC, 18 decimals, `msg.value` | ERC-20 USDC, 6 decimals, EIP-3009 |
| client sends its own transactions (needs gas) | client only signs; operator relays and pays gas |
| budget mode: pass as many as `msg.value` covers | target position: reach exactly #q or fail; ceiling + refund |
| no fee | optional operator fee, capped at 10% |
| `kick` for the operator | no kick: the operator cannot remove tickets |
| anyone creates queues; anyone joins directly | one immutable operator per contract; joins only through the operator (rate-limited) |
| `withdraw` / `withdrawFor` | `claim` / `claimWithSig` with a signed recipient |
| redeem message `x429:v1:…` | `x429:v2:…` |

## 10. Security considerations

**Who may settle.** The EIP-3009 signature fixes amount and recipient (this contract) but not the
queue or the target position. If anyone could open a queue and call `skip`, anyone who saw an
`X-PAYMENT` header could spend it on a queue of their own and pay themselves. So each contract has
exactly one operator, fixed at deploy, and only it may create queues, relay joins and settle skips.
Operators who want separate trust domains deploy separate contracts.

**Operator trust.** A dishonest operator could settle a payment with a
different target than the client asked for over HTTP; it still cannot charge more than the signed
`value`, cannot pay itself more than its capped fee, and every passed ticket still gets exactly its
posted price. Every skip is public in `Skipped` and `Passed` events. The operator also decides
offchain admission: it can refuse service, but cannot reorder the onchain queue or touch claimables.

**Front-run settlement.** The contract accepts a front-run payment if the signature is right and
enough unaccounted USDC sits in the contract. Someone who signs an authorization to the contract and
then burns its nonce with `cancelAuthorization` could, only together with the operator, claim stray
USDC that belongs to another front-run victim. The server's log check (§4.5) closes this for an
honest operator. Stray USDC only exists between a front-run and its settlement, and the server
settles a front-run payment as soon as the payer (or anyone holding the header) retries.

**Prices moving in flight.** Between the 402 and settlement other clients may skip ahead of the
payer, adding tickets to pass. The ceiling bounds the damage: the payer pays the actual cost up to
`value`, or nothing at all (`price_moved`). Ticket prices cannot change after joining in v0.2.

**Replay.** A payment is single use twice over: USDC's nonce and the contract's `paymentSettled`.
Join and claim signatures carry single-use nonces and deadlines. A redemption signature is useless
outside its admission window and after its single use.

**Griefing.** A ticket with a huge skip price cannot be passed at a sane cost; the queue degrades to
plain FIFO behind it, which is what a 429 without x429 would be. Joining is free for the client but
costs the operator gas; joins go only through the operator, which rate-limits them per client IP.
Throwaway keys from many IPs can still fill a queue up to `maxLength`; a refundable join bond is the
next step if that matters (README, known limits).

**Reentrancy.** `skip`, `claim`, `claimWithSig` and `withdrawFees` are `nonReentrant`. Every external
call goes to USDC.

**Blocklisted addresses.** USDC can blocklist addresses. A blocklisted payer cannot sign a working
authorization. A blocklisted ticket owner can still be passed (credits are internal) but cannot
claim until unblocked or until it signs a claim to another recipient.
