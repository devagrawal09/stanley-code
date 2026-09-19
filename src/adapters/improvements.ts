/**
 * Durable self-improvement queue, worker, and candidate staging under `.stanley/`.
 *
 *   .stanley/improvements/pending/<job>.json   queued by the agent fallback (exclusive create, one per request)
 *   .stanley/improvements/active/<job>.json    claimed by a worker, with a lease; stale leases are re-queued
 *   .stanley/improvements/done/<job>.json      finished jobs; a done job is never queued again automatically
 *   .stanley/improvements/worker.lock          one worker per repository (pid + start time, stale-detected)
 *   .stanley/improvements/worker.log           append-only worker diary
 *   .stanley/candidates/<job>/                 agent-authored workflow plus host-written candidate.json
 *
 * The CLI writes the job file before it exits and starts a detached worker process. The worker claims jobs one
 * at a time, runs the improvement agent confined to the candidate directory, validates what it produced with the
 * same loader active workflows use, and records a `validated` or `rejected` candidate. Nothing is activated
 * automatically: `promoteCandidate` moves a validated candidate into `.stanley/workflows/` on request.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { link, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { hashValue } from "../core/hash.ts";
import type { JsonObject } from "../core/types.ts";
import type { AgentRunResult, CodingAgentPort } from "../workflows/agent.ts";
import {
  CANDIDATE_SCHEMA,
  type CandidateChecks,
  type CandidateRecord,
  IMPROVEMENT_LIMITS,
  type ImprovementJob,
  improvementInstructions,
  isImprovementJob,
} from "../workflows/improve.ts";
import { collectDiff, statusEntries } from "./git.ts";
import { ensureStateDirectory, STATE_DIRECTORY } from "./recorder.ts";
import { redactText, safeMessage } from "./redact.ts";
import { cleanupWorkflows, discoverWorkflows, loadWorkflows, WORKFLOW_DIRECTORY } from "./workflows.ts";

export const IMPROVEMENT_DIRECTORY = `${STATE_DIRECTORY}/improvements`;
export const CANDIDATE_DIRECTORY = `${STATE_DIRECTORY}/candidates`;
export const WORKER_FLAG = "--improve-worker";

/**
 * The reference workflow embedded in every improvement brief. It is byte-identical to
 * `examples/workflows/stale-todo-audit.ts` (enforced by a test) and shows the Jev-first shape: deterministic code
 * gathers bounded evidence, `judge` asks Jev fixed-choice questions, and code decides with fixed thresholds.
 */
export const EXAMPLE_WORKFLOW = `import { readFile } from "node:fs/promises";
import { join } from "node:path";

// A Stanley workflow: an async factory that returns { id, routing metadata..., run }.
export default async ({ root, log }) => ({
  id: "stale_todo_audit",
  // Routing metadata: Jev reads every JSON field to decide when to select this workflow.
  instructions:
    "Use when the user asks to audit, list, or review TODO or FIXME comments in the repository " +
    "and decide which are stale or still needed.",
  examples: ["Audit the TODO comments", "Which FIXME notes are stale?"],
  async run({ request, judge }) {
    // 1. Deterministic evidence gathering (bounded).
    const text = await readFile(join(root, "src/app.ts"), "utf8").catch(() => "");
    const todos = text
      .split("\\n")
      .map((line, index) => ({ line: index + 1, text: line.trim() }))
      .filter((entry) => /\\b(TODO|FIXME)\\b/.test(entry.text))
      .slice(0, 20);
    log.info("todo candidates", { count: todos.length });

    // 2. Bounded Jev judgment: one small fixed-choice question per piece of evidence.
    const results = [];
    for (const todo of todos) {
      const verdict = await judge({
        scope: \`src/app.ts:\${todo.line}\`,
        state: { request, comment: todo.text },
        questions: {
          stale: {
            type: "choice",
            instructions: "Is this TODO comment still actionable?",
            criteria: {
              actionable: "Describes concrete remaining work.",
              stale: "Refers to work that is clearly done or no longer relevant.",
              cannot_tell: "The comment alone does not say.",
            },
          },
        },
      });
      // 3. Code, not the model, decides using fixed thresholds.
      const answer = verdict.ok ? verdict.answers.stale : null;
      const label =
        answer && answer.type === "choice" && answer.probabilities[answer.choice] >= 0.7
          ? answer.choice
          : "parked";
      results.push({ line: todo.line, text: todo.text, label });
    }
    return {
      text: results.map((r) => \`\${r.label.padEnd(11)} src/app.ts:\${r.line} \${r.text}\`).join("\\n"),
      data: { results, notChecked: ["only src/app.ts was scanned"] },
    };
  },
});
`;

type JobState = "pending" | "active" | "done";

interface Lease {
  readonly pid: number;
  readonly until: string;
}

type ActiveJob = ImprovementJob & { readonly lease?: Lease; readonly result?: JsonObject };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

function jobPath(root: string, state: JobState, id: string): string {
  return join(root, IMPROVEMENT_DIRECTORY, state, `${id}.json`);
}

function candidateDirectory(id: string): string {
  return `${CANDIDATE_DIRECTORY}/${id}`;
}

async function ensureQueue(root: string): Promise<void> {
  await ensureStateDirectory(root);
  for (const state of ["pending", "active", "done"] as const) {
    await mkdir(join(root, IMPROVEMENT_DIRECTORY, state), { recursive: true, mode: 0o700 });
  }
  await mkdir(join(root, CANDIDATE_DIRECTORY), { recursive: true, mode: 0o700 });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Create a file exclusively and atomically: a temporary file is hard-linked into place, never overwritten. */
async function createExclusive(path: string, content: string): Promise<boolean> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, { mode: 0o600 });
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if (code(error) === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function readJob(path: string): Promise<ActiveJob | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isImprovementJob(parsed) ? (parsed as ActiveJob) : null;
  } catch {
    return null;
  }
}

async function listJobs(root: string, state: JobState): Promise<string[]> {
  try {
    return (await readdir(join(root, IMPROVEMENT_DIRECTORY, state)))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
  } catch (error) {
    if (code(error) === "ENOENT") return [];
    throw error;
  }
}

export type EnqueueOutcome = "queued" | "already_queued" | "already_attempted" | "queue_full";

/** Durably queue a job. Returns why it was not queued when a job or candidate for the request already exists. */
export async function enqueueImprovement(root: string, job: ImprovementJob): Promise<EnqueueOutcome> {
  await ensureQueue(root);
  if (await exists(jobPath(root, "done", job.id))) return "already_attempted";
  if (await exists(join(root, candidateDirectory(job.id), "candidate.json"))) return "already_attempted";
  if (await exists(jobPath(root, "active", job.id))) return "already_queued";
  if ((await listJobs(root, "pending")).length >= IMPROVEMENT_LIMITS.maxPendingJobs) return "queue_full";
  const created = await createExclusive(
    jobPath(root, "pending", job.id),
    `${JSON.stringify(job, null, 2)}\n`,
  );
  return created ? "queued" : "already_queued";
}

export async function pendingImprovements(root: string): Promise<string[]> {
  return listJobs(root, "pending");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return code(error) === "EPERM";
  }
}

async function readLock(path: string): Promise<{ pid: number; startedAt: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; startedAt?: unknown };
    return typeof parsed.pid === "number" && typeof parsed.startedAt === "string"
      ? { pid: parsed.pid, startedAt: parsed.startedAt }
      : null;
  } catch {
    return null;
  }
}

/** Whether a live worker holds the repository's worker lock. */
export async function workerRunning(root: string, now: () => Date = () => new Date()): Promise<boolean> {
  const lock = await readLock(join(root, IMPROVEMENT_DIRECTORY, "worker.lock"));
  if (!lock) return false;
  const age = now().getTime() - Date.parse(lock.startedAt);
  return processAlive(lock.pid) && !(Number.isFinite(age) && age > IMPROVEMENT_LIMITS.leaseMs * 4);
}

async function acquireWorkerLock(
  root: string,
  pid: number,
  now: () => Date,
): Promise<(() => Promise<void>) | null> {
  const path = join(root, IMPROVEMENT_DIRECTORY, "worker.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = JSON.stringify({ pid, startedAt: now().toISOString() });
    if (await createExclusive(path, content)) return () => unlink(path).catch(() => undefined);
    if (await workerRunning(root, now)) return null;
    // Stale lock. Take it over atomically: only the process whose rename succeeds may create a new lock;
    // a competitor's rename fails with ENOENT and its next create finds the winner's live lock.
    const stale = `${path}.stale-${pid}-${Date.now()}`;
    try {
      await rename(path, stale);
    } catch {
      continue;
    }
    await unlink(stale).catch(() => undefined);
  }
  return null;
}

/** Where workflow files written by a *delegated* task agent are moved instead of being activated. */
export const QUARANTINE_DIRECTORY = `${STATE_DIRECTORY}/quarantine`;

/**
 * Move workflow files out of `.stanley/workflows/` into a timestamped quarantine directory, preserving their
 * relative paths. Nothing is deleted or rewritten; the caller reports where the files went.
 */
export async function quarantineWorkflowFiles(
  root: string,
  paths: readonly string[],
  now: () => Date = () => new Date(),
): Promise<string> {
  const stamp = now()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const directory = `${QUARANTINE_DIRECTORY}/${stamp}-${process.pid}`;
  for (const path of paths) {
    const within = relative(WORKFLOW_DIRECTORY, path);
    if (within.startsWith("..") || within === "") continue;
    const destination = join(root, directory, within);
    await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
    await rename(join(root, path), destination);
  }
  return directory;
}

/** Start a detached worker process for the repository; it outlives the CLI. Returns the child's pid. */
export function spawnImprovementWorker(options: {
  root: string;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  spawn?: typeof nodeSpawn;
}): number | undefined {
  const spawn = options.spawn ?? nodeSpawn;
  const child = spawn(process.execPath, [options.cliPath, WORKER_FLAG, "--repo", options.root], {
    cwd: options.root,
    env: options.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

export interface WorkerOptions {
  readonly root: string;
  readonly agent: CodingAgentPort;
  /** Ids the candidate must not claim: built-ins plus active repository workflows. */
  readonly reservedIds: readonly string[];
  /** Asks the router whether it would select the candidate for the job's request; null when not checkable. */
  readonly routeCheck?: (
    candidate: { id: string; routing: JsonObject },
    request: string,
  ) => Promise<boolean | null>;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly jobTimeoutMs?: number;
  /** Diary sink; defaults to `.stanley/improvements/worker.log`. */
  readonly log?: (line: string) => void | Promise<void>;
  readonly pid?: number;
}

export interface WorkerSummary {
  readonly ran: boolean;
  readonly reason?: "locked";
  readonly processed: ReadonlyArray<{ id: string; status: CandidateRecord["status"] | "requeued" }>;
}

/** Process every pending job for one repository, one at a time, then exit. Safe to run concurrently. */
export async function runImprovementWorker(options: WorkerOptions): Promise<WorkerSummary> {
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  await ensureQueue(options.root);
  const diary = join(options.root, IMPROVEMENT_DIRECTORY, "worker.log");
  const log =
    options.log ??
    ((line: string) =>
      writeFile(diary, `${now().toISOString()} ${line}\n`, { flag: "a", mode: 0o600 }).catch(
        () => undefined,
      ));
  const release = await acquireWorkerLock(options.root, pid, now);
  if (!release) return { ran: false, reason: "locked", processed: [] };
  const processed: Array<{ id: string; status: CandidateRecord["status"] | "requeued" }> = [];
  try {
    await recoverStaleLeases(options.root, now, log);
    // Every claim increments the job's attempt count and every finished attempt leaves `pending`, so this
    // loop terminates after at most maxAttempts passes per job, including retries requeued by this worker.
    // A pending entry that cannot be claimed (unreadable, not a file, rename refused) is skipped once and
    // never revisited in this run, so a broken entry cannot spin the loop.
    const skipped = new Set<string>();
    const next = async () =>
      (await listJobs(options.root, "pending")).find((candidate) => !skipped.has(candidate));
    let id = await next();
    while (id !== undefined) {
      options.signal?.throwIfAborted();
      const job = await claimJob(options.root, id, pid, now);
      if (job) {
        const status = await runJob(job, options, now, log);
        processed.push({ id, status });
      } else {
        skipped.add(id);
        await log(`skipped ${id}: pending entry could not be claimed`);
      }
      id = await next();
    }
  } finally {
    await release();
  }
  return { ran: true, processed };
}

async function recoverStaleLeases(
  root: string,
  now: () => Date,
  log: (line: string) => void | Promise<void>,
): Promise<void> {
  for (const id of await listJobs(root, "active")) {
    const job = await readJob(jobPath(root, "active", id));
    const until = job?.lease ? Date.parse(job.lease.until) : Number.NaN;
    const alive = job?.lease ? processAlive(job.lease.pid) : false;
    if (job && alive && Number.isFinite(until) && until > now().getTime()) continue;
    if (!job) {
      await unlink(jobPath(root, "active", id)).catch(() => undefined);
      continue;
    }
    const { lease: _lease, ...rest } = job;
    await writeJson(jobPath(root, "pending", id), rest);
    await unlink(jobPath(root, "active", id)).catch(() => undefined);
    await log(`requeued ${id}: stale lease`);
  }
}

async function claimJob(root: string, id: string, pid: number, now: () => Date): Promise<ActiveJob | null> {
  const job = await readJob(jobPath(root, "pending", id));
  if (!job) {
    await unlink(jobPath(root, "pending", id)).catch(() => undefined);
    return null;
  }
  const claimed: ActiveJob = {
    ...job,
    attempts: job.attempts + 1,
    lease: { pid, until: new Date(now().getTime() + IMPROVEMENT_LIMITS.leaseMs).toISOString() },
  };
  try {
    await rename(jobPath(root, "pending", id), jobPath(root, "active", id));
  } catch {
    return null;
  }
  await writeJson(jobPath(root, "active", id), claimed);
  return claimed;
}

interface Snapshot {
  readonly entries: Set<string>;
  readonly diff: string;
}

async function snapshot(root: string): Promise<Snapshot> {
  const [entries, diff] = await Promise.all([statusEntries(root), collectDiff(root, { scope: "worktree" })]);
  return { entries: new Set(entries), diff: hashValue(diff.text) };
}

/** Repository paths that appeared or changed between two snapshots (the candidate directory is Git-ignored). */
function writesSince(before: Snapshot, after: Snapshot): string[] {
  const writes = [...after.entries].filter((entry) => !before.entries.has(entry)).map((e) => e.slice(3));
  if (writes.length === 0 && after.diff !== before.diff) writes.push("(tracked file contents)");
  return writes;
}

async function runJob(
  job: ActiveJob,
  options: WorkerOptions,
  now: () => Date,
  log: (line: string) => void | Promise<void>,
): Promise<CandidateRecord["status"] | "requeued"> {
  const { root } = options;
  const directory = candidateDirectory(job.id);
  await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
  const existing = (await discoverWorkflows(root)).sources.map((source) => source.path);
  await log(`start ${job.id} attempt ${job.attempts}: ${safeMessage(job.request, 200)}`);
  const before = await snapshot(root);
  const instructions = improvementInstructions(job, {
    candidateDirectory: directory,
    workflowDirectory: WORKFLOW_DIRECTORY,
    existingWorkflows: existing,
    reservedIds: options.reservedIds,
    exampleWorkflow: EXAMPLE_WORKFLOW,
  });
  let result: AgentRunResult;
  try {
    result = await options.agent.run(
      { kind: "improve", instructions, cwd: root },
      {
        timeoutMs: options.jobTimeoutMs ?? IMPROVEMENT_LIMITS.jobTimeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  } catch (error) {
    result = {
      outcome: "failed",
      text: "",
      exitCode: null,
      durationMs: 0,
      toolCalls: 0,
      detail: messageOf(error),
    };
  }
  const outsideWrites = writesSince(before, await snapshot(root));

  // Retry only a clean failure: an agent that already wrote outside its directory is not tried again.
  if (
    (result.outcome === "timeout" || result.outcome === "failed") &&
    outsideWrites.length === 0 &&
    job.attempts < IMPROVEMENT_LIMITS.maxAttempts
  ) {
    const { lease: _lease, ...rest } = job;
    await writeJson(jobPath(root, "pending", job.id), rest);
    await unlink(jobPath(root, "active", job.id)).catch(() => undefined);
    await log(
      `requeued ${job.id}: agent ${result.outcome}${result.detail ? ` (${safeMessage(result.detail, 200)})` : ""}`,
    );
    return "requeued";
  }

  const record = await validateCandidate(root, job, result, before, outsideWrites, options, now);
  await writeJson(join(root, directory, "candidate.json"), record);
  const { lease: _lease, ...rest } = job;
  await writeJson(jobPath(root, "done", job.id), {
    ...rest,
    result: { status: record.status, workflowId: record.workflowId, finishedAt: now().toISOString() },
  });
  await unlink(jobPath(root, "active", job.id)).catch(() => undefined);
  await log(
    `${record.status} ${job.id}${record.workflowId ? ` workflow ${record.workflowId}` : ""}: ${record.reasons.join("; ") || "ok"}`,
  );
  return record.status;
}

async function validateCandidate(
  root: string,
  job: ImprovementJob,
  result: AgentRunResult,
  before: Snapshot,
  agentWrites: readonly string[],
  options: WorkerOptions,
  now: () => Date,
): Promise<CandidateRecord> {
  const directory = candidateDirectory(job.id);
  const reasons: string[] = [];
  const quarantined: string[] = [];
  // Loading imports the candidate module and awaits its factory (never `run`). That executes agent-authored
  // top-level code, so the containment check is repeated after loading and cleanup, not only after the agent.
  const loaded = await loadWorkflows({
    root,
    directory,
    warn: (message) => quarantined.push(message),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  await cleanupWorkflows(loaded.loaded, () => undefined);
  const outsideWrites = [...new Set([...agentWrites, ...writesSince(before, await snapshot(root))])];
  let workflowId: string | null = null;
  let source: string | null = null;
  let duplicateId = false;
  let routing: CandidateChecks["routing"] = "skipped";
  {
    if (result.outcome !== "finished")
      reasons.push(`agent ${result.outcome}${result.detail ? `: ${result.detail}` : ""}`);
    if (outsideWrites.length > 0)
      reasons.push(`agent changed files outside the candidate directory: ${outsideWrites.join(", ")}`);
    if (loaded.loaded.length === 0)
      reasons.push("no loadable workflow was written to the candidate directory");
    if (loaded.loaded.length > 1) reasons.push("the candidate directory contains more than one workflow");
    if (loaded.quarantined.length > 0)
      reasons.push(
        `quarantined: ${loaded.quarantined.map((d) => `${d.source} (${d.phase}) ${d.message}`).join("; ")}`,
      );
    const candidate = loaded.loaded.length === 1 ? loaded.loaded[0]! : null;
    if (candidate) {
      workflowId = candidate.workflow.id;
      source = candidate.source.path;
      duplicateId = options.reservedIds.includes(candidate.workflow.id);
      if (duplicateId) reasons.push(`workflow id ${candidate.workflow.id} is already registered`);
      if (options.routeCheck && reasons.length === 0) {
        const metadata = Object.fromEntries(
          Object.entries(candidate.workflow).filter(([field]) => !["id", "run", "cleanup"].includes(field)),
        ) as JsonObject;
        const selected = await options.routeCheck(
          { id: candidate.workflow.id, routing: metadata },
          job.request,
        );
        routing = selected === null ? "skipped" : selected ? "selected" : "not_selected";
        if (selected === false)
          reasons.push("the router did not select the candidate for the original request");
      }
    }
  }
  return {
    schema: CANDIDATE_SCHEMA,
    id: job.id,
    status: reasons.length === 0 ? "validated" : "rejected",
    workflowId,
    source,
    request: job.request,
    createdAt: now().toISOString(),
    checks: {
      loaded: loaded.loaded.length === 1,
      quarantined: loaded.quarantined.map((d) => `${d.source}: ${d.message}`),
      duplicateId,
      outsideWrites,
      routing,
    },
    reasons: reasons.map((reason) => redactText(reason).text),
    agent: { outcome: result.outcome, toolCalls: result.toolCalls, durationMs: result.durationMs },
    summary: redactText(result.text.slice(0, IMPROVEMENT_LIMITS.maxSummaryBytes)).text,
  };
}

export async function readCandidate(root: string, id: string): Promise<CandidateRecord | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(root, candidateDirectory(id), "candidate.json"), "utf8"),
    ) as CandidateRecord;
    return parsed.schema === CANDIDATE_SCHEMA && parsed.id === id ? parsed : null;
  } catch {
    return null;
  }
}

/** Every recorded candidate, oldest first by id order. */
export async function listCandidates(root: string): Promise<CandidateRecord[]> {
  let names: string[];
  try {
    names = (await readdir(join(root, CANDIDATE_DIRECTORY))).sort();
  } catch (error) {
    if (code(error) === "ENOENT") return [];
    throw error;
  }
  const records: CandidateRecord[] = [];
  for (const name of names) {
    if (!/^imp_[0-9a-f]{12}$/.test(name)) continue;
    const record = await readCandidate(root, name);
    if (record) records.push(record);
  }
  return records;
}

export class PromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionError";
  }
}

/**
 * Activate a validated candidate by moving its workflow into `.stanley/workflows/`. The candidate is loaded again
 * first; duplicate ids and existing destinations refuse rather than overwrite.
 */
export async function promoteCandidate(
  root: string,
  id: string,
  reservedIds: readonly string[],
): Promise<{ workflowId: string; destination: string }> {
  if (!/^imp_[0-9a-f]{12}$/.test(id)) throw new PromotionError(`invalid candidate id: ${id}`);
  const record = await readCandidate(root, id);
  if (!record) throw new PromotionError(`no candidate record for ${id}`);
  if (record.status !== "validated")
    throw new PromotionError(`candidate ${id} is ${record.status}, not validated`);
  if (!record.source) throw new PromotionError(`candidate ${id} has no workflow source`);
  const loaded = await loadWorkflows({ root, directory: candidateDirectory(id), warn: () => undefined });
  await cleanupWorkflows(loaded.loaded, () => undefined);
  const candidate = loaded.loaded.length === 1 && loaded.quarantined.length === 0 ? loaded.loaded[0]! : null;
  if (!candidate) throw new PromotionError(`candidate ${id} no longer validates; re-run the improvement`);
  if (reservedIds.includes(candidate.workflow.id)) {
    throw new PromotionError(`workflow id ${candidate.workflow.id} is already registered`);
  }
  await mkdir(join(root, WORKFLOW_DIRECTORY), { recursive: true, mode: 0o700 });
  const destination = `${WORKFLOW_DIRECTORY}/${basename(candidate.source.path)}`;
  if (await exists(join(root, destination))) throw new PromotionError(`${destination} already exists`);
  await rename(join(root, candidate.source.path), join(root, destination));
  await writeJson(join(root, candidateDirectory(id), "candidate.json"), {
    ...record,
    status: "promoted",
    source: destination,
  });
  return { workflowId: candidate.workflow.id, destination };
}

/** Remove a candidate directory. Used by tests and operators; never called automatically. */
export async function discardCandidate(root: string, id: string): Promise<void> {
  if (!/^imp_[0-9a-f]{12}$/.test(id)) throw new PromotionError(`invalid candidate id: ${id}`);
  await rm(join(root, candidateDirectory(id)), { recursive: true, force: true });
}
