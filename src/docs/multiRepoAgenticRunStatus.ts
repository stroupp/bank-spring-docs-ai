import * as fs from "fs/promises";
import * as path from "path";
import type { MultiRepoManifest } from "../multirepo/multiRepoManifestService";
import { maskSecretsWithStats } from "../ai/safeContextFilter";

export type AgenticRunState = "running" | "completed" | "failed" | "cancelled";
export type AgenticPhaseState = "pending" | "running" | "completed" | "skipped" | "failed" | "cancelled";

export interface AgenticPhaseAttempt {
  attempt: number;
  status: AgenticPhaseState;
  startedAt?: string;
  completedAt?: string;
  details?: Record<string, unknown>;
  artifacts?: string[];
  error?: string;
  archivedAt: string;
}

export interface AgenticRunAttempt {
  attempt: number;
  status: AgenticRunState;
  startedAt: string;
  completedAt?: string;
  currentPhase?: string;
  error?: string;
  archivedAt: string;
}

export interface AgenticRunPhase {
  id: string;
  label: string;
  category: "local" | "qwen" | "copilot";
  status: AgenticPhaseState;
  startedAt?: string;
  completedAt?: string;
  details?: Record<string, unknown>;
  artifacts?: string[];
  error?: string;
  /** The active or next attempt number. Added without changing the version 1 status schema. */
  attempt?: number;
  /** Immutable evidence from attempts reset by a resume operation. */
  history?: AgenticPhaseAttempt[];
}

export interface MultiRepoAgenticRunStatus {
  schemaVersion: 1;
  pipeline: "agentic-ui-bff-be";
  runId: string;
  projectName: string;
  branch: string;
  status: AgenticRunState;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  currentPhase?: string;
  workspaceRoot: string;
  finalDocumentPath?: string;
  estimatedTotalTokens?: number;
  requestCount?: number;
  newRequestCount?: number;
  reusedStepCount?: number;
  error?: string;
  /** The first execution is attempt 1; every prepared resume increments it. */
  attempt?: number;
  attemptStartedAt?: string;
  resumeCount?: number;
  resumedAt?: string;
  history?: AgenticRunAttempt[];
  phases: AgenticRunPhase[];
}

export interface PhaseCompletion {
  details?: Record<string, unknown>;
  artifacts?: string[];
}

export interface PhaseArtifactValidation {
  valid: boolean;
  recordedArtifacts: string[];
  existingArtifacts: string[];
  missingArtifacts: string[];
  unsafeArtifacts: string[];
  requiresCopilotOutput: boolean;
  copilotOutputArtifact?: string;
  reason?: string;
}

const phaseDefinitions: Array<Pick<AgenticRunPhase, "id" | "label" | "category">> = [
  { id: "local-ui-analysis", label: "React UI local analysis", category: "local" },
  { id: "local-bff-analysis", label: "Spring BFF local analysis", category: "local" },
  { id: "local-be-analysis", label: "Spring BE local analysis", category: "local" },
  { id: "local-traceability", label: "UI-BFF-BE traceability", category: "local" },
  { id: "qwen-semantics", label: "Qwen interaction and page-flow semantics", category: "qwen" },
  { id: "knowledge-graph", label: "Local knowledge graph", category: "local" },
  { id: "quality-report", label: "Multi-repository quality report", category: "local" },
  { id: "manifest-update", label: "Multi-repository manifest update", category: "local" },
  { id: "copilot-cross-layer-plan", label: "Copilot cross-layer plan", category: "copilot" },
  { id: "copilot-ui-analysis", label: "Copilot React UI analysis", category: "copilot" },
  { id: "copilot-bff-analysis", label: "Copilot Spring BFF analysis", category: "copilot" },
  { id: "copilot-be-analysis", label: "Copilot Spring BE analysis", category: "copilot" },
  { id: "copilot-traceability-analysis", label: "Copilot traceability analysis", category: "copilot" },
  { id: "copilot-cross-layer-diagrams", label: "Copilot cross-layer diagrams", category: "copilot" },
  { id: "copilot-final-cross-layer-synthesis", label: "Copilot final cross-layer synthesis", category: "copilot" },
  { id: "final-document", label: "Final Agentic document", category: "local" },
  { id: "run-summary", label: "Run summary", category: "local" }
];

export class MultiRepoAgenticRunStatusWriter {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly runStatusJsonPath: string;
  readonly runStatusMarkdownPath: string;

  private readonly latestStatusJsonPath: string;
  private readonly latestStatusMarkdownPath: string;
  private readonly reusablePhaseIds = new Set<string>();

  private constructor(
    private readonly status: MultiRepoAgenticRunStatus,
    private readonly statusRoot: string
  ) {
    this.runId = status.runId;
    this.workspaceRoot = status.workspaceRoot;
    this.runStatusJsonPath = path.join(this.workspaceRoot, "run-status.json");
    this.runStatusMarkdownPath = path.join(this.workspaceRoot, "run-status.md");
    this.latestStatusJsonPath = path.join(statusRoot, "latest-run-status.json");
    this.latestStatusMarkdownPath = path.join(statusRoot, "latest-run-status.md");
  }

  static async create(
    multiRepoRoot: string,
    manifest: MultiRepoManifest,
    requestedRunId?: string
  ): Promise<MultiRepoAgenticRunStatusWriter> {
    const statusRoot = path.join(multiRepoRoot, "copilot-workspace", "agentic-ui-bff-be");
    await fs.mkdir(statusRoot, { recursive: true });
    const runId = await uniqueRunId(statusRoot, requestedRunId ?? createRunId());
    const workspaceRoot = path.join(statusRoot, runId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    const now = new Date().toISOString();
    const writer = new MultiRepoAgenticRunStatusWriter({
      schemaVersion: 1,
      pipeline: "agentic-ui-bff-be",
      runId,
      projectName: manifest.projectName,
      branch: manifest.branch,
      status: "running",
      attempt: 1,
      attemptStartedAt: now,
      resumeCount: 0,
      startedAt: now,
      updatedAt: now,
      workspaceRoot,
      phases: phaseDefinitions.map((phase) => ({ ...phase, status: "pending", attempt: 1 }))
    }, statusRoot);
    await writer.persist();
    return writer;
  }

  /**
   * Loads the latest interrupted run for the same project and branch. The stored
   * workspace path is deliberately ignored and recomputed below the current
   * multi-repository root so a moved or edited status file cannot redirect writes.
   */
  static async loadLatestResumable(
    multiRepoRoot: string,
    manifest: MultiRepoManifest
  ): Promise<MultiRepoAgenticRunStatusWriter | undefined> {
    const statusRoot = path.resolve(multiRepoRoot, "copilot-workspace", "agentic-ui-bff-be");
    const latestPath = path.join(statusRoot, "latest-run-status.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(latestPath, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
        return undefined;
      }
      throw error;
    }

    if (!isStatusRecord(parsed)
      || parsed.pipeline !== "agentic-ui-bff-be"
      || parsed.schemaVersion !== 1
      || (parsed.status !== "failed" && parsed.status !== "cancelled")
      || parsed.projectName !== manifest.projectName
      || parsed.branch !== manifest.branch
      || !isSafeRunId(parsed.runId)) {
      return undefined;
    }

    const workspaceRoot = path.resolve(statusRoot, parsed.runId);
    if (!isWithin(statusRoot, workspaceRoot) || !(await exists(workspaceRoot))) {
      return undefined;
    }

    const status = normalizeLoadedStatus(parsed, manifest, workspaceRoot);
    return new MultiRepoAgenticRunStatusWriter(status, statusRoot);
  }

  snapshot(): MultiRepoAgenticRunStatus {
    return JSON.parse(JSON.stringify(this.status)) as MultiRepoAgenticRunStatus;
  }

  phaseSnapshot(phaseId: string): AgenticRunPhase {
    return JSON.parse(JSON.stringify(this.phase(phaseId))) as AgenticRunPhase;
  }

  currentAttempt(phaseId: string): number {
    return normalizeAttempt(this.phase(phaseId).attempt);
  }

  isPhaseReusable(phaseId: string): boolean {
    this.phase(phaseId);
    return this.reusablePhaseIds.has(phaseId);
  }

  async validatePhaseArtifacts(phaseId: string): Promise<PhaseArtifactValidation> {
    return validateArtifacts(this.phase(phaseId), this.workspaceRoot, this.statusRoot);
  }

  /**
   * Turns a failed, cancelled, or interrupted status into a running status while
   * keeping the same run id. Only the uninterrupted prefix whose completed or
   * skipped phases still have all recorded artifacts is reusable. The first
   * invalid/incomplete phase and every later phase are reset.
   */
  async prepareResume(): Promise<void> {
    if (this.status.status === "completed") {
      throw new Error("A completed Agentic run cannot be resumed.");
    }

    this.reusablePhaseIds.clear();
    let restartIndex = this.status.phases.length;
    for (let index = 0; index < this.status.phases.length; index += 1) {
      const phase = this.status.phases[index];
      if (phase.status !== "completed" && phase.status !== "skipped") {
        restartIndex = index;
        break;
      }
      const validation = await validateArtifacts(phase, this.workspaceRoot, this.statusRoot);
      if (!validation.valid) {
        restartIndex = index;
        break;
      }
      this.reusablePhaseIds.add(phase.id);
    }

    const now = new Date().toISOString();
    const previousRunAttempt = normalizeAttempt(this.status.attempt);
    this.status.history = [
      ...(this.status.history ?? []),
      {
        attempt: previousRunAttempt,
        status: this.status.status,
        startedAt: this.status.attemptStartedAt ?? this.status.startedAt,
        completedAt: this.status.completedAt,
        currentPhase: this.status.currentPhase,
        error: this.status.error,
        archivedAt: now
      }
    ];

    for (let index = restartIndex; index < this.status.phases.length; index += 1) {
      resetPhaseForResume(this.status.phases[index], now);
      this.reusablePhaseIds.delete(this.status.phases[index].id);
    }

    this.status.attempt = previousRunAttempt + 1;
    this.status.attemptStartedAt = now;
    this.status.resumeCount = Math.max(0, this.status.resumeCount ?? previousRunAttempt - 1) + 1;
    this.status.resumedAt = now;
    this.status.status = "running";
    this.status.completedAt = undefined;
    this.status.currentPhase = undefined;
    this.status.error = undefined;
    this.status.finalDocumentPath = undefined;
    this.status.estimatedTotalTokens = undefined;
    this.status.requestCount = undefined;
    this.status.newRequestCount = undefined;
    this.status.reusedStepCount = undefined;
    await this.persist();
  }

  async startPhase(phaseId: string): Promise<void> {
    const phase = this.phase(phaseId);
    const now = new Date().toISOString();
    phase.status = "running";
    phase.attempt = normalizeAttempt(phase.attempt);
    phase.startedAt ??= now;
    phase.completedAt = undefined;
    phase.error = undefined;
    this.status.status = "running";
    this.status.currentPhase = phaseId;
    this.status.error = undefined;
    await this.persist();
  }

  async completePhase(phaseId: string, completion: PhaseCompletion = {}): Promise<void> {
    const phase = this.phase(phaseId);
    const now = new Date().toISOString();
    phase.status = "completed";
    phase.attempt = normalizeAttempt(phase.attempt);
    phase.startedAt ??= now;
    phase.completedAt = now;
    phase.error = undefined;
    phase.details = completion.details ? { ...phase.details, ...completion.details } : phase.details;
    phase.artifacts = normalizeArtifacts([...(phase.artifacts ?? []), ...(completion.artifacts ?? [])]) ?? phase.artifacts;
    if (this.status.currentPhase === phaseId) {
      this.status.currentPhase = undefined;
    }
    await this.persist();
  }

  async updatePhase(phaseId: string, update: PhaseCompletion): Promise<void> {
    const phase = this.phase(phaseId);
    phase.details = update.details ? { ...phase.details, ...update.details } : phase.details;
    phase.artifacts = normalizeArtifacts([...(phase.artifacts ?? []), ...(update.artifacts ?? [])]) ?? phase.artifacts;
    await this.persist();
  }

  async skipPhase(phaseId: string, reason: string): Promise<void> {
    const phase = this.phase(phaseId);
    const now = new Date().toISOString();
    phase.status = "skipped";
    phase.attempt = normalizeAttempt(phase.attempt);
    phase.startedAt ??= now;
    phase.completedAt = now;
    phase.details = { reason };
    phase.error = undefined;
    if (this.status.currentPhase === phaseId) {
      this.status.currentPhase = undefined;
    }
    await this.persist();
  }

  async finishSuccess(result: {
    finalDocumentPath: string;
    estimatedTotalTokens: number;
    requestCount: number;
    newRequestCount?: number;
    reusedStepCount?: number;
  }): Promise<void> {
    const now = new Date().toISOString();
    this.status.status = "completed";
    this.status.updatedAt = now;
    this.status.completedAt = now;
    this.status.currentPhase = undefined;
    this.status.error = undefined;
    this.status.finalDocumentPath = result.finalDocumentPath;
    this.status.estimatedTotalTokens = result.estimatedTotalTokens;
    this.status.requestCount = result.requestCount;
    this.status.newRequestCount = result.newRequestCount;
    this.status.reusedStepCount = result.reusedStepCount;
    await this.persist();
  }

  async finishFailure(error: unknown, cancelled: boolean): Promise<void> {
    const now = new Date().toISOString();
    const message = errorMessage(error);
    const current = this.status.currentPhase ? this.phase(this.status.currentPhase) : undefined;
    if (current) {
      current.status = cancelled ? "cancelled" : "failed";
      current.startedAt ??= now;
      current.completedAt = now;
      current.error = message;
    }
    this.status.status = cancelled ? "cancelled" : "failed";
    this.status.updatedAt = now;
    this.status.completedAt = now;
    this.status.error = message;
    await this.persist();
  }

  private phase(phaseId: string): AgenticRunPhase {
    const phase = this.status.phases.find((item) => item.id === phaseId);
    if (!phase) {
      throw new Error(`Unknown Agentic run phase: ${phaseId}`);
    }
    return phase;
  }

  private async persist(): Promise<void> {
    this.status.updatedAt = new Date().toISOString();
    const json = `${JSON.stringify(this.status, null, 2)}\n`;
    const markdown = renderMarkdown(this.status);
    await Promise.all([
      atomicWrite(this.runStatusJsonPath, json),
      atomicWrite(this.runStatusMarkdownPath, markdown),
      atomicWrite(this.latestStatusJsonPath, json),
      atomicWrite(this.latestStatusMarkdownPath, markdown)
    ]);
  }
}

function renderMarkdown(status: MultiRepoAgenticRunStatus): string {
  const lines = [
    "# Agentic UI-BFF-BE Run Status",
    "",
    `- Run: ${status.runId}`,
    `- Project: ${status.projectName}`,
    `- Branch: ${status.branch}`,
    `- Status: ${status.status}`,
    `- Attempt: ${status.attempt ?? 1}`,
    `- Resume count: ${status.resumeCount ?? 0}`,
    `- Started: ${status.startedAt}`,
    `- Current attempt started: ${status.attemptStartedAt ?? status.startedAt}`,
    `- Updated: ${status.updatedAt}`,
    ...(status.resumedAt ? [`- Last resumed: ${status.resumedAt}`] : []),
    `- Current phase: ${status.currentPhase ?? "none"}`,
    `- Workspace: ${status.workspaceRoot}`,
    ...(status.finalDocumentPath ? [`- Final document: ${status.finalDocumentPath}`] : []),
    ...(status.requestCount !== undefined ? [`- Request attempts: ${status.requestCount}`] : []),
    ...(status.newRequestCount !== undefined ? [`- New requests in latest attempt: ${status.newRequestCount}`] : []),
    ...(status.reusedStepCount !== undefined ? [`- Reused Copilot steps: ${status.reusedStepCount}`] : []),
    ...(status.error ? [`- Error: ${status.error}`] : []),
    "",
    "## Phases",
    "",
    "| Phase | Category | Attempt | Status | Started | Completed |",
    "|---|---|---:|---|---|---|",
    ...status.phases.map((phase) => `| ${phase.label} | ${phase.category} | ${phase.attempt ?? 1} | ${phase.status} | ${phase.startedAt ?? "-"} | ${phase.completedAt ?? "-"} |`),
    ""
  ];
  const phasesWithDetails = status.phases.filter((phase) => phase.error || phase.artifacts?.length || phase.details || phase.history?.length);
  if (phasesWithDetails.length) {
    lines.push("## Phase Details", "");
    for (const phase of phasesWithDetails) {
      lines.push(`### ${phase.label}`, "");
      if (phase.error) {
        lines.push(`- Error: ${phase.error}`);
      }
      for (const artifact of phase.artifacts ?? []) {
        lines.push(`- Artifact: ${artifact}`);
      }
      if (phase.details) {
        lines.push("", "```json", JSON.stringify(phase.details, null, 2), "```");
      }
      if (phase.history?.length) {
        lines.push("", "#### Previous attempts", "");
        for (const attempt of phase.history) {
          lines.push(`- Attempt ${attempt.attempt}: ${attempt.status} (${attempt.startedAt ?? "not started"} - ${attempt.completedAt ?? "not completed"})`);
          if (attempt.error) {
            lines.push(`  - Error: ${attempt.error}`);
          }
          for (const artifact of attempt.artifacts ?? []) {
            lines.push(`  - Artifact: ${artifact}`);
          }
        }
      }
      lines.push("");
    }
  }
  if (status.history?.length) {
    lines.push("## Previous Run Attempts", "");
    for (const attempt of status.history) {
      lines.push(`- Attempt ${attempt.attempt}: ${attempt.status}; archived ${attempt.archivedAt}${attempt.error ? `; error: ${attempt.error}` : ""}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function normalizeLoadedStatus(
  loaded: Record<string, unknown>,
  manifest: MultiRepoManifest,
  workspaceRoot: string
): MultiRepoAgenticRunStatus {
  const loadedPhases = Array.isArray(loaded.phases) ? loaded.phases : [];
  const phases = phaseDefinitions.map((definition) => {
    const candidate = loadedPhases.find((item) => isObject(item) && item.id === definition.id);
    if (!isObject(candidate)) {
      return { ...definition, status: "pending" as const, attempt: 1 };
    }
    const status = isPhaseState(candidate.status) ? candidate.status : "pending";
    const history = Array.isArray(candidate.history)
      ? candidate.history.filter(isObject).map(normalizePhaseAttempt).filter((item): item is AgenticPhaseAttempt => Boolean(item))
      : undefined;
    return {
      ...definition,
      status,
      startedAt: stringValue(candidate.startedAt),
      completedAt: stringValue(candidate.completedAt),
      details: isObject(candidate.details) ? candidate.details : undefined,
      artifacts: stringArray(candidate.artifacts),
      error: stringValue(candidate.error),
      attempt: normalizeAttempt(numberValue(candidate.attempt)),
      history: history?.length ? history : undefined
    };
  });
  const state = isRunState(loaded.status) ? loaded.status : "failed";
  return {
    schemaVersion: 1,
    pipeline: "agentic-ui-bff-be",
    runId: String(loaded.runId),
    projectName: manifest.projectName,
    branch: manifest.branch,
    status: state,
    startedAt: stringValue(loaded.startedAt) ?? new Date().toISOString(),
    updatedAt: stringValue(loaded.updatedAt) ?? new Date().toISOString(),
    completedAt: stringValue(loaded.completedAt),
    currentPhase: stringValue(loaded.currentPhase),
    workspaceRoot,
    finalDocumentPath: stringValue(loaded.finalDocumentPath),
    estimatedTotalTokens: numberValue(loaded.estimatedTotalTokens),
    requestCount: numberValue(loaded.requestCount),
    newRequestCount: numberValue(loaded.newRequestCount),
    reusedStepCount: numberValue(loaded.reusedStepCount),
    error: stringValue(loaded.error),
    attempt: normalizeAttempt(numberValue(loaded.attempt)),
    attemptStartedAt: stringValue(loaded.attemptStartedAt) ?? stringValue(loaded.startedAt),
    resumeCount: Math.max(0, numberValue(loaded.resumeCount) ?? 0),
    resumedAt: stringValue(loaded.resumedAt),
    history: normalizeRunHistory(loaded.history),
    phases
  };
}

function resetPhaseForResume(phase: AgenticRunPhase, archivedAt: string): void {
  const previousAttempt = normalizeAttempt(phase.attempt);
  const hasEvidence = phase.status !== "pending"
    || Boolean(phase.startedAt || phase.completedAt || phase.error || phase.details || phase.artifacts?.length);
  if (hasEvidence) {
    phase.history = [
      ...(phase.history ?? []),
      {
        attempt: previousAttempt,
        status: phase.status,
        startedAt: phase.startedAt,
        completedAt: phase.completedAt,
        details: phase.details ? JSON.parse(JSON.stringify(phase.details)) as Record<string, unknown> : undefined,
        artifacts: phase.artifacts ? [...phase.artifacts] : undefined,
        error: phase.error,
        archivedAt
      }
    ];
    phase.attempt = previousAttempt + 1;
  } else {
    phase.attempt = previousAttempt;
  }
  phase.status = "pending";
  phase.startedAt = undefined;
  phase.completedAt = undefined;
  phase.details = undefined;
  phase.artifacts = undefined;
  phase.error = undefined;
}

async function validateArtifacts(
  phase: AgenticRunPhase,
  workspaceRoot: string,
  statusRoot: string
): Promise<PhaseArtifactValidation> {
  const recordedArtifacts = normalizeArtifacts(phase.artifacts) ?? [];
  const existingArtifacts: string[] = [];
  const missingArtifacts: string[] = [];
  const unsafeArtifacts: string[] = [];
  for (const artifact of recordedArtifacts) {
    const resolved = resolveArtifactPath(artifact, workspaceRoot, statusRoot, phase.category === "copilot");
    if (!resolved.allowed) {
      unsafeArtifacts.push(resolved.target);
    } else if (await exists(resolved.target)) {
      existingArtifacts.push(resolved.target);
    } else {
      missingArtifacts.push(resolved.target);
    }
  }

  const skippedWithoutArtifacts = phase.status === "skipped" && recordedArtifacts.length === 0;
  const requiresCopilotOutput = phase.category === "copilot" && phase.status !== "skipped";
  const copilotOutputArtifact = requiresCopilotOutput
    ? await findCopilotOutputArtifact(existingArtifacts, phase)
    : undefined;
  let reason: string | undefined;
  if (skippedWithoutArtifacts) {
    reason = undefined;
  } else if (!recordedArtifacts.length) {
    reason = "No artifacts were recorded for the phase.";
  } else if (unsafeArtifacts.length) {
    reason = `${unsafeArtifacts.length} recorded artifact(s) are outside the allowed run roots.`;
  } else if (missingArtifacts.length) {
    reason = `${missingArtifacts.length} recorded artifact(s) are missing.`;
  } else if (requiresCopilotOutput && !copilotOutputArtifact) {
    reason = "The Copilot phase has no generated output Markdown beyond prompt/context artifacts.";
  }
  return {
    valid: !reason,
    recordedArtifacts,
    existingArtifacts,
    missingArtifacts,
    unsafeArtifacts,
    requiresCopilotOutput,
    copilotOutputArtifact,
    reason
  };
}

function resolveArtifactPath(
  artifact: string,
  workspaceRoot: string,
  statusRoot: string,
  copilotPhase: boolean
): { target: string; allowed: boolean } {
  const multiRepoRoot = path.resolve(statusRoot, "..", "..");
  if (path.isAbsolute(artifact)) {
    const target = path.normalize(artifact);
    return {
      target,
      allowed: copilotPhase ? isWithinOrEqual(workspaceRoot, target) : isWithinOrEqual(multiRepoRoot, target)
    };
  }
  const workspaceCandidate = path.resolve(workspaceRoot, artifact);
  const multiRepoCandidate = path.resolve(multiRepoRoot, artifact);
  // Run-local Copilot artifacts are normally relative to the workspace; broader
  // local-analysis artifacts are normally relative to the multi-repo root.
  const target = artifact.split(/[\\/]/).length === 1 ? workspaceCandidate : multiRepoCandidate;
  return {
    target,
    allowed: copilotPhase ? isWithinOrEqual(workspaceRoot, target) : isWithinOrEqual(multiRepoRoot, target)
  };
}

async function findCopilotOutputArtifact(existingArtifacts: string[], phase: AgenticRunPhase): Promise<string | undefined> {
  const expectedStem = phase.id.startsWith("copilot-") ? phase.id.slice("copilot-".length) : phase.id;
  for (const artifact of existingArtifacts) {
    if (!isCopilotOutputMarkdown(artifact, expectedStem)) {
      continue;
    }
    try {
      const stat = await fs.stat(artifact);
      if (stat.isFile() && stat.size > 0) {
        return artifact;
      }
    } catch {
      // The existence pass can race with cleanup; treat it as invalid.
    }
  }
  return undefined;
}

function isCopilotOutputMarkdown(artifact: string, expectedStem: string): boolean {
  const basename = path.basename(artifact).toLowerCase();
  const escapedStem = expectedStem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapedStem}(?:-attempt-[1-9]\\d*)?\\.md$`, "i").test(basename);
}

function normalizePhaseAttempt(value: Record<string, unknown>): AgenticPhaseAttempt | undefined {
  if (!isPhaseState(value.status)) {
    return undefined;
  }
  return {
    attempt: normalizeAttempt(numberValue(value.attempt)),
    status: value.status,
    startedAt: stringValue(value.startedAt),
    completedAt: stringValue(value.completedAt),
    details: isObject(value.details) ? value.details : undefined,
    artifacts: stringArray(value.artifacts),
    error: stringValue(value.error),
    archivedAt: stringValue(value.archivedAt) ?? new Date(0).toISOString()
  };
}

function normalizeRunHistory(value: unknown): AgenticRunAttempt[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const history = value.filter(isObject).flatMap((item) => {
    if (!isRunState(item.status)) {
      return [];
    }
    return [{
      attempt: normalizeAttempt(numberValue(item.attempt)),
      status: item.status,
      startedAt: stringValue(item.startedAt) ?? new Date(0).toISOString(),
      completedAt: stringValue(item.completedAt),
      currentPhase: stringValue(item.currentPhase),
      error: stringValue(item.error),
      archivedAt: stringValue(item.archivedAt) ?? new Date(0).toISOString()
    } satisfies AgenticRunAttempt];
  });
  return history.length ? history : undefined;
}

function isStatusRecord(value: unknown): value is Record<string, unknown> & {
  pipeline: string;
  runId: string;
  projectName: string;
  branch: string;
  status: AgenticRunState;
} {
  return isObject(value)
    && value.pipeline === "agentic-ui-bff-be"
    && typeof value.runId === "string"
    && typeof value.projectName === "string"
    && typeof value.branch === "string"
    && isRunState(value.status);
}

function isSafeRunId(runId: string): boolean {
  return runId.length > 0
    && runId.length <= 128
    && runId !== "."
    && runId !== ".."
    && !runId.includes("/")
    && !runId.includes("\\")
    && !runId.includes("\0");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function isWithinOrEqual(root: string, candidate: string): boolean {
  return path.resolve(root) === path.resolve(candidate) || isWithin(root, candidate);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRunState(value: unknown): value is AgenticRunState {
  return value === "running" || value === "completed" || value === "failed" || value === "cancelled";
}

function isPhaseState(value: unknown): value is AgenticPhaseState {
  return value === "pending" || value === "running" || value === "completed" || value === "skipped"
    || value === "failed" || value === "cancelled";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function normalizeAttempt(value: number | undefined): number {
  return value && Number.isInteger(value) && value > 0 ? value : 1;
}

async function uniqueRunId(statusRoot: string, baseRunId: string): Promise<string> {
  let candidate = baseRunId;
  let suffix = 2;
  while (await exists(path.join(statusRoot, candidate))) {
    candidate = `${baseRunId}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function createRunId(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function normalizeArtifacts(artifacts?: string[]): string[] | undefined {
  if (!artifacts?.length) {
    return undefined;
  }
  return [...new Set(artifacts.map((artifact) => path.normalize(artifact)))];
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return maskSecretsWithStats(message).text.slice(0, 4000);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}
