import assert from "node:assert/strict";
import { test } from "node:test";
import { rejectSecrets, pubSignals } from "./signals.js";

test("refuses spending and viewing keys", () => {
  assert.throws(() => rejectSecrets({ proof: {}, spendingKey: "1" }), /spending or viewing secret/);
  assert.throws(() => rejectSecrets({ inputs: [{ viewingPrivate: "ab" }] }), /spending or viewing secret/);
});

test("accepts a public proof payload", () => {
  rejectSecrets({
    chain: "evm",
    kind: "transact",
    proof: { pubSignals: Array.from({ length: 17 }, (_, i) => String(i)) },
    ciphertext0: "0xab",
  });
});

test("reads 17 public signals and strips a leading one", () => {
  const base = Array.from({ length: 17 }, (_, i) => BigInt(i + 2));
  assert.deepEqual(pubSignals({ pubSignals: base.map(String) }), base);
  assert.deepEqual(pubSignals({ pubSignals: ["1", ...base.map(String)] }), base);
});
