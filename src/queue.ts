import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingJob, StoredJob } from "./types.js";

const FILE = resolve(process.cwd(), "data/jobs.json");

let jobs: StoredJob[] = [];

function save() {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(jobs, null, 2));
}

export function loadQueue() {
  try {
    jobs = JSON.parse(readFileSync(FILE, "utf8")) as StoredJob[];
    for (const job of jobs) {
      if (job.status === "submitting") job.status = "queued";
    }
  } catch {
    jobs = [];
  }
}

export function enqueue(body: IncomingJob, tip: bigint): StoredJob {
  const job: StoredJob = {
    id: randomUUID(),
    receivedAt: new Date().toISOString(),
    status: "queued",
    chain: body.chain,
    kind: body.kind,
    tip: tip.toString(),
    body,
  };
  jobs.push(job);
  save();
  return job;
}

export function getJob(id: string): StoredJob | undefined {
  return jobs.find((job) => job.id === id);
}

export function listJobs(): StoredJob[] {
  return jobs.map(({ body: _body, ...rest }) => rest as StoredJob);
}

export function takeQueued(): StoredJob | undefined {
  const job = jobs.find((item) => item.status === "queued");
  if (!job) return undefined;
  job.status = "submitting";
  save();
  return job;
}

export function finish(id: string, update: { status: "submitted" | "failed"; tx?: string; error?: string }) {
  const job = jobs.find((item) => item.id === id);
  if (!job) return;
  job.status = update.status;
  job.tx = update.tx;
  job.error = update.error;
  save();
}
