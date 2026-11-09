# Lacuna relayer

A relayer takes **finished proofs** from users, pays chain fees, and keeps the tip inside the proof.

Anyone can run one. Clone this repo, fund a wallet, start the server, and publish your URL plus your address. Users bake that address into `relayRecipient` and `POST` the job here.

This process never sees a spending key or a viewing key. It only sees the public proof (amounts, public recipient, tip) and the ciphertexts that will already land on chain.

Shields and deposits cannot be relayed. The user has to send the tokens.

## Earn

The pool pays `relayFee` to `relayRecipient` as part of the proof.

This server rejects a job when:

- `relayRecipient` is not this relayer
- the tip is below estimated gas plus `MIN_PROFIT_WEI` / `MIN_PROFIT_LAMPORTS`
- the payload includes a spending or viewing secret
- the kind is an unpaid `proveInnocence` or `swapExecute` (those have no tip; leave them off unless you set the matching env flag)

Private sends must include a native tip. A proof with `relayFee = 0` is unpaid gas.

## Run

Node 20 or newer.

```bash
npm install
cp .env.example .env
```

Set at least one chain:

- EVM: `EVM_RPC_URL`, `EVM_PRIVATE_KEY`, `EVM_POOL` (and `EVM_RELAY` for swaps)
- Solana: `SOLANA_RPC_URL`, `SOLANA_KEYPAIR` (JSON array or a path to one), `SOLANA_POOL_PROGRAM`

Fund those wallets. Then:

```bash
npm start
```

`GET /info` prints the addresses users must put in the proof.

## API

`GET /info` — this relayer’s addresses and fee floor.

`POST /jobs` — enqueue a finished proof. Returns `202` and a job id, or `400` if the tip is too small.

`GET /jobs/:id` — `queued`, `submitting`, `submitted`, or `failed`.

### EVM private send / unshield

```json
{
  "chain": "evm",
  "kind": "transact",
  "proof": { "pA": ["0x…", "0x…"], "pB": [["0x…", "0x…"], ["0x…", "0x…"]], "pC": ["0x…", "0x…"], "pubSignals": ["…"] },
  "ciphertext0": "0x",
  "ciphertext1": "0x"
}
```

`pubSignals[11]` is the tip. `pubSignals[14]` must be this relayer.

Optional `poi` is a proof-of-innocence submitted first when the pool requires one.

### EVM swap

Same proof, `kind` `transactAndCall`, plus `calls` and `shields`. The public recipient in the proof must be the Lacuna relay contract.

### Solana transact

Same proof shape, `chain` `solana`. For a token exit, also send `tokenMint0`, ATAs, and `recipient`.

### Solana swap prepare

`kind` `swapPrepare` with the transact proof, mints, hop program, owner hashes, and cipher hashes. Do not send note secrets.

## What this relayer will not do

- Decrypt notes
- Learn the private sender or the private recipient
- Submit a shield
- Submit a job that pays less than gas plus your minimum profit
