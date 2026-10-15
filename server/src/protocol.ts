// Protocol constants and EIP-712 payload builders shared by the server, the MCP tools and agent-sim.
import { formatUnits, parseUnits, type Address, type Hex } from "viem";

export const PROTOCOL_VERSION = "0.2";
export const BASE_CHAIN_ID = 8453;
/** Native USDC on Base mainnet (FiatTokenV2_2, 6 decimals, EIP-3009). */
export const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** EIP-712 domain name/version of USDC on Base. x402 puts these in `extra`. */
export const USDC_EIP712 = { name: "USD Coin", version: "2" } as const;
export const USDC_DECIMALS = 6;

export const TICKET_HEADER = "x-429-ticket";
export const SIGNATURE_HEADER = "x-429-signature";

export const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const joinTypes = {
  Join: [
    { name: "owner", type: "address" },
    { name: "queueId", type: "uint32" },
    { name: "skipPrice", type: "uint128" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const claimTypes = {
  Claim: [
    { name: "owner", type: "address" },
    { name: "recipient", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const eip712DomainType = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

export function checkoutDomain(chainId: number, contract: Address) {
  return { name: "x429 Checkout", version: "1", chainId, verifyingContract: contract } as const;
}

export function usdcDomain(chainId: number, usdc: Address) {
  return { ...USDC_EIP712, chainId, verifyingContract: usdc } as const;
}

/**
 * EIP-712 `Join` in the JSON shape wallets sign (eth_signTypedData_v4, and PayBox
 * `request_wallet_sign` with `intent: {op: "typedData", typedData}`). Numbers are decimal strings.
 */
export function joinTypedData(p: {
  chainId: number;
  contract: Address;
  owner: Address;
  queueId: number;
  skipPrice: bigint;
  nonce: Hex;
  deadline: bigint;
}) {
  return {
    domain: checkoutDomain(p.chainId, p.contract),
    types: { EIP712Domain: eip712DomainType, ...joinTypes },
    primaryType: "Join" as const,
    message: {
      owner: p.owner,
      queueId: p.queueId,
      skipPrice: p.skipPrice.toString(),
      nonce: p.nonce,
      deadline: p.deadline.toString(),
    },
  };
}

export function claimTypedData(p: {
  chainId: number;
  contract: Address;
  owner: Address;
  recipient: Address;
  nonce: Hex;
  deadline: bigint;
}) {
  return {
    domain: checkoutDomain(p.chainId, p.contract),
    types: { EIP712Domain: eip712DomainType, ...claimTypes },
    primaryType: "Claim" as const,
    message: { owner: p.owner, recipient: p.recipient, nonce: p.nonce, deadline: p.deadline.toString() },
  };
}

/** The EIP-3009 authorization a wallet signs for an x402 `exact` payment to `payTo`. */
export function transferWithAuthorizationTypedData(p: {
  chainId: number;
  usdc: Address;
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}) {
  return {
    domain: usdcDomain(p.chainId, p.usdc),
    types: transferWithAuthorizationTypes,
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from: p.from,
      to: p.to,
      value: p.value,
      validAfter: p.validAfter,
      validBefore: p.validBefore,
      nonce: p.nonce,
    },
  };
}

/** The EIP-191 message a ticket owner signs to redeem a served ticket. */
export function ticketMessage(chainId: number, contract: Address, ticketId: bigint | string): string {
  return `x429:v2:${chainId}:${contract.toLowerCase()}:${ticketId.toString()}`;
}

export function caip2(chainId: number): string {
  return `eip155:${chainId}`;
}

/** `usdc("0.031")` → 31000n (6 decimals). */
export function usdc(amount: string | number): bigint {
  return parseUnits(typeof amount === "number" ? amount.toString() : amount, USDC_DECIMALS);
}

/** 31000n → "0.031". */
export function fmtUsdc(units: bigint): string {
  return formatUnits(units, USDC_DECIMALS);
}

/** 31000n → "$0.031". */
export function fmtUsd(units: bigint): string {
  return `$${fmtUsdc(units)}`;
}
