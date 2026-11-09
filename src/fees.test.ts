import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTip, solanaSubmitCost } from "./fees.js";

test("rejects a job with no tip", () => {
  const result = checkTip({
    tip: 0n,
    tipIsNative: true,
    gasCostNative: 1n,
    minProfitNative: 1n,
    acceptTokenTips: false,
    minTokenTip: 0n,
  });
  assert.equal(result.ok, false);
});

test("accepts a native tip that covers gas plus profit", () => {
  const result = checkTip({
    tip: 15n,
    tipIsNative: true,
    gasCostNative: 10n,
    minProfitNative: 5n,
    acceptTokenTips: false,
    minTokenTip: 0n,
  });
  assert.equal(result.ok, true);
});

test("rejects a native tip that does not cover gas plus profit", () => {
  const result = checkTip({
    tip: 14n,
    tipIsNative: true,
    gasCostNative: 10n,
    minProfitNative: 5n,
    acceptTokenTips: false,
    minTokenTip: 0n,
  });
  assert.equal(result.ok, false);
});

test("rejects a token tip unless the operator opted in", () => {
  const closed = checkTip({
    tip: 100n,
    tipIsNative: false,
    gasCostNative: 1n,
    minProfitNative: 1n,
    acceptTokenTips: false,
    minTokenTip: 0n,
  });
  assert.equal(closed.ok, false);
  const open = checkTip({
    tip: 100n,
    tipIsNative: false,
    gasCostNative: 1n,
    minProfitNative: 1n,
    acceptTokenTips: true,
    minTokenTip: 50n,
  });
  assert.equal(open.ok, true);
});

test("solana submit cost adds signature fees to the floor", () => {
  assert.equal(solanaSubmitCost(4, 10_000_000n), 10_020_000n);
});
