import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function bool(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(env(name).toLowerCase());
}

function loadDotEnv() {
  const path = resolve(process.cwd(), ".env");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
    let value = trimmed.slice(trimmed.indexOf("=") + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

export const config = {
  port: Number(env("PORT", "8787")),
  evmRpc: env("EVM_RPC_URL"),
  evmKey: env("EVM_PRIVATE_KEY"),
  evmPool: env("EVM_POOL"),
  evmRelay: env("EVM_RELAY"),
  minProfitWei: BigInt(env("MIN_PROFIT_WEI", "10000000000000")),
  acceptTokenTips: bool("ACCEPT_TOKEN_TIPS"),
  minTokenTip: BigInt(env("MIN_TOKEN_TIP", "0")),
  solanaRpc: env("SOLANA_RPC_URL"),
  solanaKeypair: env("SOLANA_KEYPAIR"),
  solanaPool: env("SOLANA_POOL_PROGRAM", "2JNUVMq3Qg3DM5SUFDXXaW1zjxDUkt8WMNtMAwJmJPiH"),
  minProfitLamports: BigInt(env("MIN_PROFIT_LAMPORTS", "10000000")),
  relayFreePoi: bool("RELAY_FREE_POI"),
  relayUnpaidSwaps: bool("RELAY_UNPAID_SWAPS"),
};

export function evmEnabled(): boolean {
  return Boolean(config.evmRpc && config.evmKey && config.evmPool);
}

export function solanaEnabled(): boolean {
  return Boolean(config.solanaRpc && config.solanaKeypair && config.solanaPool);
}
