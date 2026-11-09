export const SIG = {
  nullifier0: 1,
  nullifier1: 2,
  commitment0: 3,
  commitment1: 4,
  amount0: 5,
  amount1: 6,
  recipient: 7,
  token0: 8,
  token1: 9,
  twoTokens: 10,
  relayFee: 11,
  fee0: 12,
  fee1: 13,
  relayRecipient: 14,
  externalHash: 15,
} as const;

const FORBIDDEN = [
  "spendingKey",
  "spending_key",
  "viewingPrivate",
  "viewing_private",
  "viewingKey",
  "inSpendingKey",
];

export function asBig(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && value !== "") return BigInt(value);
  throw new Error("Expected an integer");
}

export function pubSignals(body: { pubSignals?: unknown }): bigint[] {
  const list = body.pubSignals;
  if (!Array.isArray(list)) throw new Error("pubSignals is required");
  let signals = list.map(asBig);
  if (signals.length === 18 && signals[0] === 1n) signals = signals.slice(1);
  if (signals.length !== 17) throw new Error("A transact proof must carry 17 public signals");
  return signals;
}

export function poiSignals(body: { pubSignals?: unknown }): bigint[] {
  const list = body.pubSignals;
  if (!Array.isArray(list)) throw new Error("pubSignals is required");
  let signals = list.map(asBig);
  if (signals.length === 3 && signals[0] === 1n) signals = signals.slice(1);
  if (signals.length !== 2) throw new Error("An innocence proof must carry 2 public signals");
  return signals;
}

export function rejectSecrets(value: unknown, path = ""): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) rejectSecrets(item, path);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (FORBIDDEN.some((name) => name.toLowerCase() === key.toLowerCase())) {
      throw new Error(`${here} is a spending or viewing secret. A relayer never accepts those.`);
    }
    rejectSecrets(child, here);
  }
}

export function nativeToken(signals: bigint[]): boolean {
  return signals[SIG.token0] === 0n;
}

export function needsPublicExit(signals: bigint[]): boolean {
  return signals[SIG.amount0] > 0n || signals[SIG.amount1] > 0n || signals[SIG.relayFee] > 0n;
}
