import {
  cleanupWorkflows,
  type LoadWorkflowsOptions,
  loadWorkflows,
  type WorkflowLoadResult,
} from "../adapters/workflows.ts";
import type { JsonObject } from "../core/types.ts";
import {
  type RoutingFacts,
  validateWorkflow,
  type Workflow,
  workflowRoutingMetadata,
} from "../core/workflow.ts";
import { CANNOT_TELL, type RoutingCandidate } from "./router.ts";

export type WorkflowKind = "builtin" | "repository";

/** Where a registered workflow came from: `builtin`, or a repository-relative workflow path. */
export type WorkflowOrigin = string;

export interface RegisteredWorkflow {
  readonly id: string;
  readonly kind: WorkflowKind;
  readonly origin: WorkflowOrigin;
  /** The validated workflow object; the runtime executes it whatever its kind. */
  readonly workflow: Workflow;
  /** Its JSON routing metadata, presented unchanged (after redaction) as the router's choice criteria. */
  readonly routing: JsonObject;
}

/** Ids the router itself uses as labels; no workflow may claim them. */
export const RESERVED_WORKFLOW_IDS: ReadonlySet<string> = new Set([CANNOT_TELL]);

export class DuplicateWorkflowIdError extends Error {
  readonly id: string;
  readonly origins: readonly WorkflowOrigin[];

  constructor(id: string, origins: readonly WorkflowOrigin[]) {
    super(`duplicate workflow id: ${id} (registered by ${origins.join(" and ")})`);
    this.name = "DuplicateWorkflowIdError";
    this.id = id;
    this.origins = origins;
  }
}

export class ReservedWorkflowIdError extends Error {
  constructor(id: string, origin: WorkflowOrigin) {
    super(`reserved workflow id: ${id} (from ${origin})`);
    this.name = "ReservedWorkflowIdError";
  }
}

export interface Registration {
  readonly workflow: Workflow;
  readonly origin: WorkflowOrigin;
  readonly kind?: WorkflowKind;
}

/**
 * The single source of truth for what a request may route to: routing metadata, deterministic eligibility, and
 * the executable workflow behind every id. Built-ins and repository workflows share one id space; duplicate ids
 * always fail registration, so nothing overrides a built-in or another workflow and nothing is chosen by
 * precedence.
 */
export class WorkflowRegistry {
  private readonly entries = new Map<string, RegisteredWorkflow>();

  /** Register one workflow. Rejects duplicate and reserved ids. */
  register(workflow: Workflow, kind: WorkflowKind, origin: WorkflowOrigin = kind): void {
    this.registerAll([{ workflow, origin, kind }]);
  }

  /** Register several workflows atomically: if any id is duplicate or reserved, none are registered. */
  registerAll(registrations: readonly Registration[]): void {
    const additions = registrations.map(({ workflow, origin, kind }): RegisteredWorkflow => {
      const validated = validateWorkflow(workflow);
      return {
        id: validated.id,
        kind: kind ?? "repository",
        origin,
        workflow: validated,
        routing: workflowRoutingMetadata(validated),
      };
    });
    const seen = new Map<string, WorkflowOrigin>();
    for (const entry of additions) {
      if (RESERVED_WORKFLOW_IDS.has(entry.id)) throw new ReservedWorkflowIdError(entry.id, entry.origin);
      const existing = this.entries.get(entry.id)?.origin ?? seen.get(entry.id);
      if (existing !== undefined) throw new DuplicateWorkflowIdError(entry.id, [existing, entry.origin]);
      seen.set(entry.id, entry.origin);
    }
    for (const entry of additions) this.entries.set(entry.id, entry);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): RegisteredWorkflow | undefined {
    return this.entries.get(id);
  }

  /** The kind of a registered workflow, or undefined if not registered. */
  kindOf(id: string): WorkflowKind | undefined {
    return this.entries.get(id)?.kind;
  }

  /** All registered workflow ids in registration order. */
  ids(): readonly string[] {
    return [...this.entries.keys()];
  }

  /** All registrations in registration order. */
  workflows(): readonly RegisteredWorkflow[] {
    return [...this.entries.values()];
  }

  /** Router candidates for every workflow, in registration order. */
  candidates(): readonly RoutingCandidate[] {
    return this.workflows().map(({ id, routing }) => ({ id, routing }));
  }

  /** Deterministic eligibility of every workflow: its own `available` gate, minus explicit exclusions. */
  capabilities(facts: RoutingFacts, excluded: ReadonlySet<string> = new Set()): Record<string, boolean> {
    const capabilities: Record<string, boolean> = {};
    for (const { id, workflow } of this.workflows()) {
      capabilities[id] = !excluded.has(id) && (workflow.available?.(facts) ?? true);
    }
    return capabilities;
  }

  get size(): number {
    return this.entries.size;
  }
}

/** A registry holding the given built-in workflows, in order. */
export function createRegistry(builtins: readonly Workflow[]): WorkflowRegistry {
  const registry = new WorkflowRegistry();
  registry.registerAll(builtins.map((workflow) => ({ workflow, origin: "builtin", kind: "builtin" })));
  return registry;
}

/**
 * Load repository workflows and register them atomically. Quarantined workflows are reported and skipped. A
 * duplicate or reserved id fails registration; every initialized workflow is then cleaned up and the error is
 * rethrown.
 */
export async function registerRepositoryWorkflows(
  registry: WorkflowRegistry,
  options: LoadWorkflowsOptions,
): Promise<WorkflowLoadResult> {
  const result = await loadWorkflows(options);
  try {
    registry.registerAll(result.loaded.map(({ workflow, source }) => ({ workflow, origin: source.path })));
  } catch (error) {
    await cleanupWorkflows(result.loaded, options.warn);
    throw error;
  }
  return result;
}
