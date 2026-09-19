// Public package API. This module is the top of the dependency graph; no production module imports it.

// adapters: port implementations for a local workspace and the TypeSafe SDK
export { parseComments } from "./adapters/comments.ts";
export { configuredModel, jevFromEnvironment } from "./adapters/config.ts";
export {
  createArtifactStore,
  createEvidenceParser,
  createWorkflowDependencies,
  createWorkspaceSource,
} from "./adapters/dependencies.ts";
export { parseUnifiedDiff } from "./adapters/diff.ts";
export { createFakeAgent, type FakeAgentCall } from "./adapters/fake-agent.ts";
export { createFakeAdapter, fakeChoice, fakeNoul, fakeScore } from "./adapters/fake-jev.ts";
// adapters: durable self-improvement queue, worker, and candidate staging
export {
  CANDIDATE_DIRECTORY,
  discardCandidate,
  type EnqueueOutcome,
  EXAMPLE_WORKFLOW,
  enqueueImprovement,
  IMPROVEMENT_DIRECTORY,
  listCandidates,
  PromotionError,
  pendingImprovements,
  promoteCandidate,
  QUARANTINE_DIRECTORY,
  quarantineWorkflowFiles,
  readCandidate,
  runImprovementWorker,
  spawnImprovementWorker,
  WORKER_FLAG,
  type WorkerOptions,
  type WorkerSummary,
  workerRunning,
} from "./adapters/improvements.ts";
export { classifyError, createSdkAdapter, MissingCredentialError } from "./adapters/jev.ts";
export { parseFailureLog } from "./adapters/logs.ts";
// adapters: the Pi coding-agent port implementation
export {
  AGENT_ENV,
  AGENT_MODEL_ENV,
  type AgentAvailability,
  type AgentUnavailableReason,
  agentEnvironment,
  agentFromEnvironment,
  createPiAgent,
  findPiBinary,
  NESTED_ENV,
  PI_ADAPTER_NAME,
  PI_BINARY_ENV,
  PI_FIXED_ARGS,
  type PiAgentOptions,
  PiEventReader,
} from "./adapters/pi.ts";
export { ensureStateDirectory, STATE_DIRECTORY } from "./adapters/recorder.ts";
export { redactJson, redactText } from "./adapters/redact.ts";
export { parseTestRecords } from "./adapters/test-records.ts";
// adapters: repository workflow discovery and loading
export {
  cleanupWorkflows,
  discoverWorkflows,
  formatWorkflowDiagnostic,
  type LoadedWorkflow,
  type LoadWorkflowsOptions,
  loadWorkflows,
  WORKFLOW_DIRECTORY,
  type WorkflowDiagnostic,
  type WorkflowDirectoryChanges,
  type WorkflowDiscovery,
  type WorkflowLoadPhase,
  type WorkflowLoadResult,
  type WorkflowSource,
  workflowDirectoryChanges,
  workflowDirectoryFingerprint,
} from "./adapters/workflows.ts";
// cli: the built-in workflows, the registry, the router, the runtime, the judge primitive, and output
export {
  BUILTINS,
  type Builtin,
  type BuiltinHost,
  type BuiltinInput,
  type BuiltinInvocation,
  type BuiltinName,
  builtinWorkflows,
  inputText,
  isBuiltinName,
  runBuiltin,
} from "./cli/builtins.ts";
export { createWorkflowJudge, type WorkflowJudgeOptions } from "./cli/judge.ts";
export { EXIT, exitCodeFor, renderHuman, UsageError } from "./cli/output.ts";
export {
  jsonPromptResult,
  PROMPT_RESULT_SCHEMA,
  packetPromptResult,
  promptResultExitCode,
  renderPromptResult,
  unsupportedPromptResult,
} from "./cli/prompt-result.ts";
export {
  createRegistry,
  DuplicateWorkflowIdError,
  RESERVED_WORKFLOW_IDS,
  type RegisteredWorkflow,
  type Registration,
  ReservedWorkflowIdError,
  registerRepositoryWorkflows,
  type WorkflowKind,
  type WorkflowOrigin,
  WorkflowRegistry,
} from "./cli/registry.ts";
export {
  CANNOT_TELL,
  ROUTING_POLICY,
  type RoutingCandidate,
  type RoutingContext,
  type RoutingDecision,
  type RoutingDependencies,
  RoutingError,
  routeIntent,
} from "./cli/router.ts";
export {
  type FallbackReason,
  PROMPT_LIMITS,
  WorkflowRuntime,
  type WorkflowRuntimeOptions,
} from "./cli/runtime.ts";
// core: generic frames, questions, validation, budgets, batching, and execution
export { mapPool, shard, withSplitting } from "./core/batch.ts";
export { Budget, type BudgetDenial, type BudgetLimits, estimateTokens } from "./core/budget.ts";
export {
  type FrameAttempt,
  FrameExecutor,
  type FrameExecutorOptions,
  type FrameFailure,
  type FrameOutcome,
  type FrameSink,
} from "./core/executor.ts";
export { createFrame } from "./core/frame.ts";
export { hashValue, stableId, stableStringify } from "./core/hash.ts";
export { choice, noul, type Question, type Questions, score } from "./core/questions.ts";
export type {
  Frame,
  JevCallOptions,
  JevPort,
  JevRequest,
  JevStatus,
  JevUsage,
  JsonObject,
  JsonValue,
  TransportFailure,
} from "./core/types.ts";
export {
  type ChoiceAnswer,
  expectKeys,
  readAnswers,
  readChoice,
  readEnvelope,
  readNoul,
  readScore,
  type ScoreAnswer,
  type TypedAnswer,
  ValidationError,
} from "./core/validation.ts";
// core: the public workflow contract and control-envelope validation
export {
  CONTROL_FIELDS,
  createWorkflowLog,
  type DiffPresence,
  FORBIDDEN_FIELDS,
  type InputShape,
  isPromptResult,
  isWorkflowValue,
  JUDGE_LIMITS,
  type JudgeFailure,
  type JudgeFn,
  type JudgeRequest,
  type JudgeResult,
  type PromptFn,
  type PromptResult,
  type RoutingFacts,
  validateJudgeRequest,
  validateWorkflow,
  validateWorkflowFactory,
  WORKFLOW_ID_PATTERN,
  WORKFLOW_STATUSES,
  type Workflow,
  type WorkflowFactory,
  type WorkflowInitContext,
  type WorkflowLog,
  type WorkflowLogLevel,
  type WorkflowLogRecord,
  type WorkflowRunContext,
  type WorkflowStatus,
  WorkflowValidationError,
  type WorkflowValue,
  workflowResult,
  workflowRoutingMetadata,
} from "./core/workflow.ts";
// workflows: the coding-agent port, delegation fallback, and self-improvement model
export {
  AGENT_LIMITS,
  type AgentOutcome,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentTask,
  type AgentTaskKind,
  type CodingAgentPort,
  DELEGATION_NOT_CHECKED,
  delegationInstructions,
  delegationResult,
} from "./workflows/agent.ts";
// workflows, plus their run context, evidence types, and ports
export {
  COMPATIBILITY_REVIEW,
  compatibilityReview,
  DIFF_ANALYSIS_KINDS,
  DIFF_ANALYSIS_POLICY,
  type DiffAnalysisInput,
  type DiffAnalysisKind,
  type DiffAnalysisResult,
  PERFORMANCE_REVIEW,
  performanceReview,
  REVIEW,
  review,
  SECURITY_REVIEW,
  SUMMARIZE,
  securityReview,
  summarize,
  TEST_GAPS,
  testGaps,
} from "./workflows/analyze-diff.ts";
export {
  type CheckInput,
  type CheckResult,
  type CheckSection,
  type CheckSource,
  check,
} from "./workflows/check.ts";
export { parseCriteria } from "./workflows/check-criteria.ts";
export { parseRules } from "./workflows/check-rules.ts";
export { classifyPath, globToRegExp, isSecretPath } from "./workflows/classify.ts";
export { diffPresence, loadDiff } from "./workflows/common.ts";
export { InputError } from "./workflows/errors.ts";
export type {
  DiffFile,
  FailureBlock,
  Hunk,
  ParsedLog,
  ReviewComment,
  TestRecord,
} from "./workflows/evidence.ts";
export { CODE_CHANGE_FALLBACK_NOTICE, type FindInput, type FindResult, find } from "./workflows/find.ts";
export { ladderForHunk } from "./workflows/hunks.ts";
export {
  CANDIDATE_SCHEMA,
  type CandidateChecks,
  type CandidateRecord,
  type CandidateStatus,
  createImprovementJob,
  describeCandidate,
  IMPROVEMENT_JOB_SCHEMA,
  IMPROVEMENT_LIMITS,
  type ImprovementContext,
  type ImprovementJob,
  improvementInstructions,
  improvementJobId,
  isImprovementJob,
  normalizeRequest,
} from "./workflows/improve.ts";
export type {
  ArtifactStore,
  ArtifactWriter,
  DiffSelection,
  DiffSource,
  EvidenceParser,
  RedactionPort,
  WorkflowDependencies,
  WorkspaceSource,
} from "./workflows/ports.ts";
export { buildFrame, type Outcome, Run, type RunOptions } from "./workflows/run.ts";
export {
  type TriageCommentsInput,
  type TriageCommentsResult,
  type TriageFailuresInput,
  type TriageFailuresResult,
  type TriageInput,
  type TriageKind,
  type TriageResult,
  triage,
  triageComments,
  triageFailures,
} from "./workflows/triage.ts";
export * from "./workflows/types.ts";
