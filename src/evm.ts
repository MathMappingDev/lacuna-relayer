import { Contract, JsonRpcProvider, Wallet, ZeroAddress } from "ethers";
import { checkTip } from "./fees.js";
import { config, evmEnabled } from "./config.js";
import { SIG, asBig, nativeToken, poiSignals, pubSignals } from "./signals.js";
import type { IncomingJob } from "./types.js";

const poolAbi = [
  "function transact(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[17] pubSignals, bytes ciphertext0, bytes ciphertext1, tuple(address collection, uint256 id) nft0, tuple(address collection, uint256 id) nft1)",
  "function proveInnocence(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[2] pubSignals)",
];

const relayAbi = [
  "function transactAndCall(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[17] pubSignals, bytes ciphertext0, bytes ciphertext1, tuple(address collection, uint256 id) nft0, tuple(address collection, uint256 id) nft1, tuple(address target, uint256 value, bytes data)[] calls, tuple(address token, uint256 tokenId, bool nft, uint256 ownerHash, bytes ciphertext)[] shields)",
];

const emptyNft = { collection: ZeroAddress, id: 0n };

let wallet: Wallet | undefined;
let pool: Contract | undefined;
let relay: Contract | undefined;

export function evmAddress(): string | undefined {
  return wallet?.address;
}

export function startEvm() {
  if (!evmEnabled()) return;
  const provider = new JsonRpcProvider(config.evmRpc);
  wallet = new Wallet(config.evmKey, provider);
  pool = new Contract(config.evmPool, poolAbi, wallet);
  if (config.evmRelay) relay = new Contract(config.evmRelay, relayAbi, wallet);
}

function nft(leg?: { collection: string; id: string }) {
  if (!leg) return emptyNft;
  return { collection: leg.collection, id: asBig(leg.id) };
}

function proofArgs(proof: NonNullable<IncomingJob["proof"]>, signals: bigint[]) {
  return [proof.pA, proof.pB, proof.pC, signals.map((value) => value.toString())] as const;
}

export async function checkEvmJob(body: IncomingJob): Promise<bigint> {
  if (!wallet || !pool) throw new Error("This relayer is not configured for EVM");
  if (body.kind === "proveInnocence") {
    if (!config.relayFreePoi) throw new Error("This relayer does not submit unpaid proof-of-innocence jobs");
    if (!body.proof) throw new Error("proof is required");
    poiSignals(body.proof);
    return 0n;
  }
  if (!body.proof) throw new Error("proof is required");
  const signals = pubSignals(body.proof);
  if (signals[SIG.relayRecipient] !== BigInt(wallet.address)) {
    throw new Error("relayRecipient is not this relayer");
  }
  const feeData = await wallet.provider!.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
  const args = [
    ...proofArgs(body.proof, signals),
    body.ciphertext0 ?? "0x",
    body.ciphertext1 ?? "0x",
    nft(body.nft0),
    nft(body.nft1),
  ];
  let gas = 400_000n;
  try {
    if (body.kind === "transactAndCall") {
      if (!relay) throw new Error("EVM_RELAY is not set");
      gas = await relay.transactAndCall.estimateGas(...args, body.calls ?? [], body.shields ?? []);
    } else {
      gas = await pool.transact.estimateGas(...args);
    }
  } catch (error) {
    throw new Error(`Gas estimate failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const gasCost = gas * gasPrice;
  const tip = signals[SIG.relayFee];
  const checked = checkTip({
    tip,
    tipIsNative: nativeToken(signals),
    gasCostNative: gasCost,
    minProfitNative: config.minProfitWei,
    acceptTokenTips: config.acceptTokenTips,
    minTokenTip: config.minTokenTip,
  });
  if (!checked.ok) throw new Error(checked.reason);
  return tip;
}

export async function submitEvm(body: IncomingJob): Promise<string> {
  if (!wallet || !pool) throw new Error("This relayer is not configured for EVM");
  if (body.poi) {
    const poi = poiSignals(body.poi);
    const tx = await pool.proveInnocence(...proofArgs(body.poi, poi));
    await tx.wait();
  }
  if (body.kind === "proveInnocence") {
    if (!body.proof) throw new Error("proof is required");
    const poi = poiSignals(body.proof);
    const tx = await pool.proveInnocence(...proofArgs(body.proof, poi));
    const receipt = await tx.wait();
    return receipt?.hash ?? tx.hash;
  }
  if (!body.proof) throw new Error("proof is required");
  const signals = pubSignals(body.proof);
  const args = [
    ...proofArgs(body.proof, signals),
    body.ciphertext0 ?? "0x",
    body.ciphertext1 ?? "0x",
    nft(body.nft0),
    nft(body.nft1),
  ];
  const tx =
    body.kind === "transactAndCall"
      ? await relay!.transactAndCall(...args, body.calls ?? [], body.shields ?? [])
      : await pool.transact(...args);
  const receipt = await tx.wait();
  return receipt?.hash ?? tx.hash;
}
