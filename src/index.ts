import { createServer } from "node:http";
import { config, evmEnabled, solanaEnabled } from "./config.js";
import { checkEvmJob, evmAddress, startEvm, submitEvm } from "./evm.js";
import { enqueue, finish, getJob, listJobs, loadQueue, takeQueued } from "./queue.js";
import { rejectSecrets } from "./signals.js";
import { checkSolanaJob, solanaAddress, startSolana, submitSolana } from "./solana.js";
import type { IncomingJob } from "./types.js";

const KINDS = new Set(["transact", "transactAndCall", "proveInnocence", "swapPrepare", "swapExecute"]);

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Body is too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicJob(id: string) {
  const job = getJob(id);
  if (!job) return undefined;
  return {
    id: job.id,
    receivedAt: job.receivedAt,
    status: job.status,
    chain: job.chain,
    kind: job.kind,
    tip: job.tip,
    tx: job.tx,
    error: job.error,
  };
}

async function checkJob(body: IncomingJob): Promise<bigint> {
  if (body.chain === "evm") return checkEvmJob(body);
  if (body.chain === "solana") return checkSolanaJob(body);
  throw new Error("chain must be evm or solana");
}

async function submitJob(body: IncomingJob): Promise<string> {
  if (body.chain === "evm") return submitEvm(body);
  return submitSolana(body);
}

let busy = false;

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (true) {
      const job = takeQueued();
      if (!job) return;
      try {
        const tx = await submitJob(job.body);
        finish(job.id, { status: "submitted", tx });
        console.log(job.id, job.chain, job.kind, "submitted", tx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finish(job.id, { status: "failed", error: message });
        console.log(job.id, job.chain, job.kind, "failed", message);
      }
    }
  } finally {
    busy = false;
  }
}

loadQueue();
startEvm();
await startSolana();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://relayer.local");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/info")) {
      json(res, 200, {
        evm: evmEnabled() ? { address: evmAddress(), pool: config.evmPool, relay: config.evmRelay } : null,
        solana: solanaEnabled() ? { address: solanaAddress(), program: config.solanaPool } : null,
        minProfitWei: config.minProfitWei.toString(),
        minProfitLamports: config.minProfitLamports.toString(),
        acceptTokenTips: config.acceptTokenTips,
        privacy: "This relayer never accepts spending or viewing keys. It only sees the public proof.",
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/jobs") {
      json(res, 200, listJobs().map((job) => ({
        id: job.id,
        receivedAt: job.receivedAt,
        status: job.status,
        chain: job.chain,
        kind: job.kind,
        tip: job.tip,
        tx: job.tx,
        error: job.error,
      })));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/jobs/")) {
      const found = publicJob(url.pathname.slice("/jobs/".length));
      if (!found) {
        json(res, 404, { error: "Unknown job" });
        return;
      }
      json(res, 200, found);
      return;
    }
    if (req.method === "POST" && url.pathname === "/jobs") {
      const body = (await readBody(req)) as IncomingJob;
      rejectSecrets(body);
      if (body.chain !== "evm" && body.chain !== "solana") throw new Error("chain must be evm or solana");
      if (!KINDS.has(body.kind)) throw new Error("Unknown kind");
      if (body.kind === "transactAndCall" && body.chain !== "evm") {
        throw new Error("transactAndCall is EVM only");
      }
      if ((body.kind === "swapPrepare" || body.kind === "swapExecute") && body.chain !== "solana") {
        throw new Error("Solana swaps only");
      }
      const tip = await checkJob(body);
      const job = enqueue(body, tip);
      json(res, 202, publicJob(job.id));
      void pump();
      return;
    }
    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(config.port, () => {
  console.log(`Relayer listening on :${config.port}`);
  console.log("EVM", evmEnabled() ? evmAddress() : "off");
  console.log("Solana", solanaEnabled() ? solanaAddress() : "off");
  void pump();
});
