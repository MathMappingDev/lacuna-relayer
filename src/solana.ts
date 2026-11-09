import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { keccak256 } from "ethers";
import { checkTip, solanaSubmitCost } from "./fees.js";
import { config, solanaEnabled } from "./config.js";
import { SIG, asBig, nativeToken, needsPublicExit, poiSignals, pubSignals } from "./signals.js";
import type { IncomingJob } from "./types.js";

const require = createRequire(import.meta.url);
const { buildPoseidon } = require("circomlibjs") as {
  buildPoseidon: () => Promise<{ F: { toObject: (value: unknown) => unknown } } & ((inputs: unknown) => unknown)>;
};

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BN254_Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const LEVELS = 16;
const TREE_CAPACITY = 65536;

type Hasher = (left: bigint, right: bigint) => bigint;

let hash2: Hasher | undefined;
let connection: Connection | undefined;
let payer: Keypair | undefined;
let program: Program | undefined;
let poolProgram: PublicKey | undefined;

export function solanaAddress(): string | undefined {
  return payer?.publicKey.toBase58();
}

function be32(value: bigint): Buffer {
  return Buffer.from(value.toString(16).padStart(64, "0"), "hex");
}

function toBig(bytes: number[] | Uint8Array): bigint {
  return BigInt("0x" + Buffer.from(bytes).toString("hex"));
}

function bytesField(data: Uint8Array): bigint {
  return BigInt(keccak256(data)) % FIELD;
}

function pubkeyField(key: PublicKey): bigint {
  return bytesField(key.toBytes());
}

function pda(seeds: (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, poolProgram!)[0];
}

function configPda() {
  return pda([Buffer.from("config")]);
}
function vaultPda() {
  return pda([Buffer.from("vault")]);
}
function treePda() {
  return pda([Buffer.from("tree")]);
}
function tokenPda(tokenId: Buffer) {
  return pda([Buffer.from("token"), tokenId]);
}
function rootPda(root: Buffer) {
  return pda([Buffer.from("root"), root]);
}
function commitmentPda(commitment: Buffer) {
  return pda([Buffer.from("commitment"), commitment]);
}
function nullifierPda(nullifier: Buffer) {
  return pda([Buffer.from("nullifier"), nullifier]);
}
function notePda(treeNumber: bigint, index: bigint) {
  const tree = Buffer.alloc(8);
  tree.writeBigUInt64LE(treeNumber);
  const leaf = Buffer.alloc(8);
  leaf.writeBigUInt64LE(index);
  return pda([Buffer.from("note"), tree, leaf]);
}
function proofBufferPda(authority: PublicKey) {
  return pda([Buffer.from("buffer"), Buffer.from("proof"), authority.toBuffer()]);
}
function cipherBufferPda(authority: PublicKey, slot: number) {
  return pda([Buffer.from("buffer"), Buffer.from("cipher"), authority.toBuffer(), Buffer.from([slot])]);
}
function poiOkPda(nullifier: Buffer, root: Buffer) {
  return pda([Buffer.from("poi_ok"), nullifier, root]);
}
function escrowPda(nullifier0: Buffer) {
  return pda([Buffer.from("escrow"), nullifier0]);
}

function parseHex(value: string): bigint {
  return BigInt(value);
}

function packGroth16(proof: NonNullable<IncomingJob["proof"]>, signalCount: number): Buffer {
  const ax = parseHex(proof.pA[0]);
  const ay = parseHex(proof.pA[1]);
  const negAy = (BN254_Q - (ay % BN254_Q)) % BN254_Q;
  const a = Buffer.concat([be32(ax), be32(negAy)]);
  const b = Buffer.concat([
    be32(parseHex(proof.pB[0][0])),
    be32(parseHex(proof.pB[0][1])),
    be32(parseHex(proof.pB[1][0])),
    be32(parseHex(proof.pB[1][1])),
  ]);
  const c = Buffer.concat([be32(parseHex(proof.pC[0])), be32(parseHex(proof.pC[1]))]);
  let signals = proof.pubSignals.map((value) => BigInt(value));
  if (signals.length === signalCount + 1 && signals[0] === 1n) signals = signals.slice(1);
  if (signals.length !== signalCount) throw new Error(`Proof must carry ${signalCount} public signals`);
  return Buffer.concat([a, b, c, ...signals.map(be32)]);
}

function hexBytes(hex: string): Buffer {
  if (!hex || hex === "0x") return Buffer.alloc(0);
  return Buffer.from(hex.startsWith("0x") ? hex.slice(2) : hex, "hex");
}

function loadKeypair(value: string): Keypair {
  const raw = value.trim().startsWith("[") ? value : readFileSync(value, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
}

async function getHasher(): Promise<Hasher> {
  if (hash2) return hash2;
  const poseidon = await buildPoseidon();
  hash2 = (left: bigint, right: bigint) => {
    const digest = (poseidon as unknown as (inputs: bigint[]) => unknown)([left, right]);
    return BigInt(String(poseidon.F.toObject(digest)));
  };
  return hash2;
}

export async function startSolana() {
  if (!solanaEnabled()) return;
  connection = new Connection(config.solanaRpc, "confirmed");
  payer = loadKeypair(config.solanaKeypair);
  poolProgram = new PublicKey(config.solanaPool);
  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const idlPath = fileURLToPath(new URL("../idl/lacuna_pool.json", import.meta.url));
  const idl = JSON.parse(readFileSync(idlPath, "utf8"));
  program = new Program(idl, provider);
  await getHasher();
}

async function ensureCipher(slot: number, hex: string) {
  const pdaKey = cipherBufferPda(payer!.publicKey, slot);
  const info = await connection!.getAccountInfo(pdaKey);
  if (!info) {
    await program!.methods.createCipherBuffer(slot).accounts({ payer: payer!.publicKey, buffer: pdaKey }).rpc();
  }
  await program!.methods.writeCipherBuffer(0, hexBytes(hex)).accounts({ payer: payer!.publicKey, buffer: pdaKey }).rpc();
  return pdaKey;
}

async function ensureProof(packed: Buffer) {
  const pdaKey = proofBufferPda(payer!.publicKey);
  const info = await connection!.getAccountInfo(pdaKey);
  if (!info) {
    await program!.methods.createProofBuffer().accounts({ payer: payer!.publicKey, buffer: pdaKey }).rpc();
  }
  const chunk = 800;
  for (let offset = 0; offset < packed.length; offset += chunk) {
    await program!.methods
      .writeProofBuffer(offset, packed.subarray(offset, offset + chunk))
      .accounts({ payer: payer!.publicKey, buffer: pdaKey })
      .rpc();
  }
  return pdaKey;
}

async function insertOutputs(commitments: bigint[]) {
  const hasher = await getHasher();
  const tree = await program!.account.tree.fetch(treePda());
  let treeNumber = Number(tree.treeNumber);
  let nextIndex = Number(tree.nextIndex);
  let filled = (tree.filledSubtrees as number[][]).map((row) => toBig(row));
  const zeros = (tree.zeros as number[][]).map((row) => toBig(row));
  const startIndex = nextIndex;
  const notes: PublicKey[] = [];
  const commitmentsPdas: PublicKey[] = [];
  const roots: PublicKey[] = [];
  for (const commitment of commitments) {
    if (commitment === 0n) {
      notes.push(notePda(0n, 0n));
      commitmentsPdas.push(commitmentPda(be32(0n)));
      roots.push(rootPda(be32(0n)));
      continue;
    }
    if (nextIndex >= TREE_CAPACITY) {
      treeNumber += 1;
      nextIndex = 0;
      filled = zeros.slice();
    }
    let current = commitment;
    let index = nextIndex;
    for (let level = 0; level < LEVELS; level++) {
      if (index % 2 === 0) {
        filled[level] = current;
        current = hasher(current, zeros[level]);
      } else {
        current = hasher(filled[level], current);
      }
      index = Math.floor(index / 2);
    }
    commitmentsPdas.push(commitmentPda(be32(commitment)));
    notes.push(notePda(BigInt(treeNumber), BigInt(nextIndex)));
    roots.push(rootPda(be32(current)));
    nextIndex += 1;
  }
  return { startIndex, notes, commitmentsPdas, roots };
}

function key(value: string | undefined): PublicKey | null {
  return value ? new PublicKey(value) : null;
}

export async function checkSolanaJob(body: IncomingJob): Promise<bigint> {
  if (!payer || !program) throw new Error("This relayer is not configured for Solana");
  if (body.kind === "proveInnocence") {
    if (!config.relayFreePoi) throw new Error("This relayer does not submit unpaid proof-of-innocence jobs");
    if (!body.proof) throw new Error("proof is required");
    poiSignals(body.proof);
    return 0n;
  }
  if (body.kind === "swapExecute") {
    if (!config.relayUnpaidSwaps) {
      throw new Error("swapExecute does not pay a tip; set RELAY_UNPAID_SWAPS=1 to submit it");
    }
    if (!body.nullifier0 || !body.mintIn || !body.mintOut || !body.outCiphertext || !body.commitment) {
      throw new Error("swapExecute needs nullifier0, mints, outCiphertext, and commitment");
    }
    return 0n;
  }
  if (!body.proof) throw new Error("proof is required");
  const signals = pubSignals(body.proof);
  if (signals[SIG.relayRecipient] !== pubkeyField(payer.publicKey)) {
    throw new Error("relayRecipient is not this relayer");
  }
  const packed = packGroth16(body.proof, 17);
  const writes = 3n + BigInt(Math.ceil(packed.length / 800));
  const gas = solanaSubmitCost(writes, 0n);
  const tip = signals[SIG.relayFee];
  const checked = checkTip({
    tip,
    tipIsNative: nativeToken(signals),
    gasCostNative: gas,
    minProfitNative: config.minProfitLamports,
    acceptTokenTips: config.acceptTokenTips,
    minTokenTip: config.minTokenTip,
  });
  if (!checked.ok) throw new Error(checked.reason);
  return tip;
}

function mintField(mint: PublicKey): bigint {
  const field = pubkeyField(mint);
  if (field === 0n) throw new Error("Mint field collided with native SOL");
  return field;
}

async function transactAccounts(body: IncomingJob, signals: bigint[]) {
  const packed = packGroth16(body.proof!, 17);
  const proofPda = await ensureProof(packed);
  const c0 = await ensureCipher(0, body.ciphertext0 ?? "0x");
  const c1 = await ensureCipher(1, body.ciphertext1 ?? "0x");
  const inserted = await insertOutputs([signals[SIG.commitment0], signals[SIG.commitment1]]);
  const cfg = await program!.account.config.fetch(configPda());
  const remaining: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = [];
  const innocenceRoot = Buffer.from(cfg.innocenceRoot as number[]);
  if (cfg.poiRequired && needsPublicExit(signals) && toBig(innocenceRoot) !== 0n) {
    for (const nf of [signals[SIG.nullifier0], signals[SIG.nullifier1]]) {
      if (nf === 0n) continue;
      remaining.push({ pubkey: poiOkPda(be32(nf), innocenceRoot), isWritable: false, isSigner: false });
    }
  }
  const token0 = signals[SIG.token0] === 0n ? Buffer.alloc(32) : be32(signals[SIG.token0]);
  const needExit = needsPublicExit(signals) || signals[SIG.fee0] > 0n || signals[SIG.fee1] > 0n;
  const tokenProgram = key(body.tokenProgram) ?? (body.tokenMint0 ? TOKEN_PROGRAM_ID : null);
  return {
    startIndex: inserted.startIndex,
    remaining,
    accounts: {
      payer: payer!.publicKey,
      config: configPda(),
      vault: vaultPda(),
      tree: treePda(),
      proof: proofPda,
      ciphertext0: c0,
      ciphertext1: c1,
      knownRoot: rootPda(be32(signals[0])),
      nullifier0: nullifierPda(be32(signals[SIG.nullifier0])),
      nullifier1: nullifierPda(be32(signals[SIG.nullifier1])),
      commitment0: inserted.commitmentsPdas[0],
      commitment1: inserted.commitmentsPdas[1],
      root0: inserted.roots[0],
      root1: inserted.roots[1],
      note0: inserted.notes[0],
      note1: inserted.notes[1],
      tokenState0: needExit ? tokenPda(token0) : null,
      tokenState1: signals[SIG.twoTokens] === 1n ? tokenPda(be32(signals[SIG.token1])) : null,
      recipient: key(body.recipient),
      relayRecipient: payer!.publicKey,
      mint0: key(body.tokenMint0),
      mint1: key(body.tokenMint1),
      vaultAta0: key(body.vaultAta0),
      vaultAta1: key(body.vaultAta1),
      recipientAta0: key(body.recipientAta0),
      recipientAta1: key(body.recipientAta1),
      relayAta: key(body.relayAta),
      tokenProgram,
      systemProgram: SystemProgram.programId,
    },
  };
}

async function submitTransact(body: IncomingJob): Promise<string> {
  const signals = pubSignals(body.proof!);
  const built = await transactAccounts(body, signals);
  return program!.methods
    .transact(new BN(built.startIndex))
    .accounts(built.accounts as never)
    .remainingAccounts(built.remaining)
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
    .rpc();
}

export async function submitSolana(body: IncomingJob): Promise<string> {
  if (!payer || !program) throw new Error("This relayer is not configured for Solana");
  if (body.kind === "proveInnocence") {
    const signals = poiSignals(body.proof!);
    const packed = packGroth16(body.proof!, 2);
    const signature = await program.methods
      .proveInnocence([...be32(signals[1])], packed)
      .accounts({
        payer: payer.publicKey,
        poiOk: poiOkPda(be32(signals[1]), be32(signals[0])),
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc();
    return signature;
  }
  if (body.kind === "swapExecute") {
    const nullifier0 = asBig(body.nullifier0);
    const mintIn = new PublicKey(body.mintIn!);
    const mintOut = new PublicKey(body.mintOut!);
    const tokenProgram = key(body.tokenProgram) ?? TOKEN_PROGRAM_ID;
    const escrow = escrowPda(be32(nullifier0));
    const escrowAccount = await program.account.swapEscrow.fetch(escrow);
    const commitment = asBig(body.commitment);
    const cipher = await ensureCipher(2, body.outCiphertext ?? "0x");
    const inserted = await insertOutputs([commitment]);
    const vault = vaultPda();
    const tokenIdOut = body.tokenIdOut ? asBig(body.tokenIdOut) : mintField(mintOut);
    return program.methods
      .swapExecute(new BN(inserted.startIndex.toString()), hexBytes(body.hopData ?? "0x"))
      .accounts({
        payer: payer.publicKey,
        config: configPda(),
        vault,
        tree: treePda(),
        escrow,
        mintIn,
        mintOut,
        escrowAta: getAssociatedTokenAddressSync(mintIn, escrow, true, tokenProgram),
        vaultAtaIn: getAssociatedTokenAddressSync(mintIn, vault, true, tokenProgram),
        vaultAtaOut: getAssociatedTokenAddressSync(mintOut, vault, true, tokenProgram),
        hopProgram: new PublicKey(body.hopProgram ?? body.hop ?? ""),
        preparer: escrowAccount.preparer,
        ciphertext: cipher,
        commitment: inserted.commitmentsPdas[0],
        root: inserted.roots[0],
        note: inserted.notes[0],
        tokenStateIn: tokenPda(be32(mintField(mintIn))),
        tokenStateOut: tokenPda(be32(tokenIdOut)),
        tokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as never)
      .remainingAccounts(
        (body.hopAccounts ?? []).map((account) => ({
          pubkey: new PublicKey(account.pubkey),
          isWritable: Boolean(account.isWritable),
          isSigner: false,
        })),
      )
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
      .rpc();
  }
  if (body.kind === "swapPrepare") {
    if (!body.mintIn || !body.mintOut || !body.outOwnerHash || !body.refundOwnerHash) {
      throw new Error("swapPrepare needs mints and owner hashes, not spending keys");
    }
    const signals = pubSignals(body.proof!);
    const built = await transactAccounts(body, signals);
    const nullifier0 = body.nullifier0 ? asBig(body.nullifier0) : signals[SIG.nullifier0];
    const mintIn = new PublicKey(body.mintIn);
    const mintOut = new PublicKey(body.mintOut);
    const tokenProgram = key(body.tokenProgram) ?? TOKEN_PROGRAM_ID;
    const escrow = escrowPda(be32(nullifier0));
    return program.methods
      .swapPrepare(
        new BN(built.startIndex),
        new BN(asBig(body.minOut ?? "0").toString()),
        [...be32(asBig(body.outOwnerHash))],
        [...be32(asBig(body.refundOwnerHash))],
        [...be32(nullifier0)],
        [...hexBytes(body.outCipherHash ?? "0x")],
        [...hexBytes(body.refundCipherHash ?? "0x")],
      )
      .accounts({
        payer: payer.publicKey,
        escrow,
        mintIn,
        mintOut,
        hopProgram: new PublicKey(body.hopProgram ?? body.hop ?? ""),
        escrowAta: getAssociatedTokenAddressSync(mintIn, escrow, true, tokenProgram),
        tokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        transact: built.accounts,
      } as never)
      .remainingAccounts(built.remaining)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
      .rpc();
  }
  return submitTransact(body);
}
