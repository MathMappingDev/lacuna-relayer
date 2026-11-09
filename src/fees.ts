export type TipCheck = { ok: true } | { ok: false; reason: string };

export function checkTip(input: {
  tip: bigint;
  tipIsNative: boolean;
  gasCostNative: bigint;
  minProfitNative: bigint;
  acceptTokenTips: boolean;
  minTokenTip: bigint;
}): TipCheck {
  if (input.tip <= 0n) return { ok: false, reason: "Job pays no relayer tip" };
  if (input.tipIsNative) {
    const need = input.gasCostNative + input.minProfitNative;
    if (input.tip < need) {
      return { ok: false, reason: `Tip ${input.tip} is below gas plus min profit ${need}` };
    }
    return { ok: true };
  }
  if (!input.acceptTokenTips) {
    return { ok: false, reason: "This relayer only accepts native ETH or SOL tips" };
  }
  if (input.tip < input.minTokenTip) {
    return { ok: false, reason: `Token tip ${input.tip} is below the minimum ${input.minTokenTip}` };
  }
  return { ok: true };
}

export function solanaSubmitCost(writes: number, minProfit: bigint): bigint {
  const lamportsPerSig = 5000n;
  return BigInt(writes) * lamportsPerSig + minProfit;
}
