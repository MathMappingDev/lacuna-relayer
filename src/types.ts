export type Chain = "evm" | "solana";

export type Kind = "transact" | "transactAndCall" | "proveInnocence" | "swapPrepare" | "swapExecute";

export type JobStatus = "queued" | "submitting" | "submitted" | "failed";

export type ProofParts = {
  pA: [string, string];
  pB: [[string, string], [string, string]];
  pC: [string, string];
  pubSignals: string[];
};

export type NftLeg = { collection: string; id: string };

export type Call = { target: string; value: string; data: string };

export type ShieldPlan = {
  token: string;
  tokenId?: string;
  nft?: boolean;
  ownerHash: string;
  ciphertext: string;
};

export type SolanaAccount = { pubkey: string; isWritable?: boolean; isSigner?: boolean };

export type IncomingJob = {
  chain: Chain;
  kind: Kind;
  proof?: ProofParts;
  poi?: ProofParts;
  ciphertext0?: string;
  ciphertext1?: string;
  nft0?: NftLeg;
  nft1?: NftLeg;
  calls?: Call[];
  shields?: ShieldPlan[];
  tokenMint0?: string;
  tokenMint1?: string;
  vaultAta0?: string;
  vaultAta1?: string;
  recipientAta0?: string;
  recipientAta1?: string;
  relayAta?: string;
  tokenProgram?: string;
  recipient?: string;
  mintIn?: string;
  mintOut?: string;
  hop?: string;
  hopProgram?: string;
  hopData?: string;
  hopAccounts?: SolanaAccount[];
  minOut?: string;
  amountOut?: string;
  nullifier0?: string;
  outOwnerHash?: string;
  refundOwnerHash?: string;
  outCipherHash?: string;
  refundCipherHash?: string;
  outCiphertext?: string;
  commitment?: string;
  tokenIdOut?: string;
  nextIndex?: string;
};

export type StoredJob = {
  id: string;
  receivedAt: string;
  status: JobStatus;
  chain: Chain;
  kind: Kind;
  tip: string;
  error?: string;
  tx?: string;
  body: IncomingJob;
};
