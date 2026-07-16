import * as fs from "fs/promises";
import * as path from "path";
import { readJsonl, writeJsonl } from "../../storage/jsonlWriter";
import { buildPageArtifactMetadata, PageArtifactMetadata } from "../pageArtifactMetadata";
import { ArtifactFreshnessService } from "../artifactFreshnessService";
import { PageOutputFreshnessService } from "../pageOutputFreshnessService";
import { atomicWriteJson } from "../../storage/atomicFile";
import { sha256 } from "../../utils/hash";

export interface PageQualityMetricExplanation {
  metric: string;
  status: "measured" | "unknown";
  value: number | null;
  weight: number;
  reason: string;
}

export interface PageDocumentQualityScore {
  generatedAt: string;
  pipelineVersion: string;
  inputHash: string;
  sourceArtifactModifiedTimes: Record<string, string>;
  page: string;
  route?: string;
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  requiredSectionsPresent: number;
  requiredSectionsTotal: number;
  sourceReferenceCount: number;
  unresolvedGapCount: number;
  highSeverityGapCount: number;
  uiApiCallCoverage: number | null;
  bffMatchCoverage: number | null;
  beMatchCoverage: number | null;
  parameterCoverage: number | null;
  validationCoverage: number | null;
  serviceFlowCoverage: number | null;
  repositoryEntityCoverage: number | null;
  qwenSemanticCoverage: number | null;
  evidencePackAvailable: boolean;
  contextPackAvailable: boolean;
  finalDocumentLength: number;
  metricsWithUnknownData: string[];
  metricExplanations: PageQualityMetricExplanation[];
  outputFreshnessIssues: number;
}

const requiredSections = [
  "Sayfa Amaci",
  "Route ve Ana Component",
  "Kullanilan Alt Componentler",
  "Kritik Kullanici Aksiyonlari",
  "Form Alanlari ve Parametreler",
  "UI State Yonetimi",
  "UI API Cagrilari",
  "BFF Endpoint Eslesmesi",
  "BFF Sorumluluklari",
  "Backend Endpoint Eslesmesi",
  "Backend Servis / Repository / Entity Akisi",
  "DTO ve Model Kullanimi",
  "Validasyon ve Hata Yonetimi",
  "Guvenlik Gozlemleri",
  "Degisiklik Etkisi ve Riskler",
  "Kaynak Referanslari",
  "Belirsizlikler"
];

export class PageDocumentQualityScorer {
  async score(multiRepoRoot: string, pageRoot: string): Promise<PageDocumentQualityScore> {
    await fs.mkdir(pageRoot, { recursive: true });
    const pageFlowPath = path.join(pageRoot, "page-flow.json");
    const gapsPath = path.join(pageRoot, "detected-gaps.json");
    const finalDocPath = path.join(pageRoot, "final-page-technical-analysis.md");
    const contextPackAvailable = await exists(path.join(pageRoot, "page-context-pack.md"));
    const evidencePackAvailable = await exists(path.join(pageRoot, "page-evidence-pack.md"));
    const pageFlowAvailable = await exists(pageFlowPath);
    const gapsAvailable = await exists(gapsPath);
    const qwenPageAvailable = await exists(path.join(pageRoot, "qwen-page-semantics.json"));
    const qwenInteractionAvailable = await exists(path.join(pageRoot, "qwen-interaction-semantics.jsonl"));
    const pageFlow = await readJson(pageFlowPath);
    const selectedPage = pageFlow.selectedPage as Record<string, unknown> | undefined;
    const draft = await readOptional(path.join(pageRoot, "copilot-draft.md"));
    const finalDoc = await readOptional(finalDocPath) || draft;
    const storedContextSelection = await readJson(path.join(pageRoot, "copilot-draft-context-selection.json"));
    const contextSelection = storedContextSelection.draftHash === sha256(draft)
      ? storedContextSelection
      : {};
    const semanticUsage = resolveSemanticUsage(
      contextSelection,
      draft,
      qwenPageAvailable,
      qwenInteractionAvailable
    );
    const finalDocAvailable = await exists(finalDocPath);
    const outputFreshnessDependencies = [
      "page-context-pack.md",
      "page-evidence-pack.md",
      ...(gapsAvailable ? ["detected-gaps.json"] : []),
      ...(finalDocAvailable ? ["copilot-draft.md"] : []),
      ...((await exists(path.join(pageRoot, "repaired-sections.md"))) ? ["repaired-sections.md"] : [])
    ];
    const outputChecks: Array<{ target: string; dependencies: string[] }> = [{
      target: finalDocAvailable ? "final-page-technical-analysis.md" : "copilot-draft.md",
      dependencies: outputFreshnessDependencies
    }];
    const draftDependencies = [
      "page-context-pack.md",
      "page-evidence-pack.md",
      ...(semanticUsage.pageUsed ? ["qwen-page-semantics.json"] : []),
      ...(semanticUsage.interactionUsed ? ["qwen-interaction-semantics.jsonl"] : [])
    ];
    outputChecks.push({ target: "copilot-draft.md", dependencies: draftDependencies });
    if (semanticUsage.pageUsed) {
      outputChecks.push({ target: "qwen-page-semantics.json", dependencies: ["page-context-pack.md", "page-evidence-pack.md"] });
    }
    if (semanticUsage.interactionUsed) {
      outputChecks.push({ target: "qwen-interaction-semantics.jsonl", dependencies: ["page-context-pack.md", "page-evidence-pack.md", "page-flow.json"] });
    }
    const outputFreshness = await new PageOutputFreshnessService().checkMany(pageRoot, outputChecks);
    const artifactFreshness = await new ArtifactFreshnessService().check(pageRoot);
    const outputFreshnessIssueCount = outputFreshness.issues.length + artifactFreshness.warnings.length;
    const gaps = await readJsonArray(gapsPath);
    const headings = extractNormalizedHeadings(finalDoc);
    const requiredSectionsPresent = requiredSections.filter((section) => headings.has(normalizeHeading(section))).length;
    const sourceReferenceCount = (finalDoc.match(/src[\\/][^\s)`]+?\.(?:java|ts|tsx|js|jsx|properties|ya?ml|json)/g) ?? []).length;
    const highSeverityGapCount = gaps.filter((gap) => gap.severity === "high").length;
    const qwenFreshnessIssues = outputFreshness.issues.filter((issue) => issue.target.startsWith("qwen-")).length;
    const qwenSemanticCoverage = semanticUsage.disabled
      ? 0
      : semanticUsage.pageUsed
        ? (qwenFreshnessIssues ? 0.5 : 1)
        : null;
    const finalDocumentLength = finalDoc.length;
    const metricsWithUnknownData = new Set<string>([
      ...(!pageFlowAvailable ? ["page-flow"] : []),
      ...(!contextPackAvailable ? ["context-pack"] : []),
      ...(!evidencePackAvailable ? ["evidence-pack"] : []),
      ...(!gapsAvailable ? ["gap-report"] : []),
      ...(!finalDoc ? ["final-or-draft-document"] : []),
      ...(outputFreshnessIssueCount ? ["stale-output"] : [])
    ]);

    const uiApiCalls = asRecords(pageFlow.uiApiCalls);
    const uiApiCallCount = uiApiCalls.length;
    const matchedBffCount = nonEmptyCount(pageFlow.uiToBffMatches, "bffEndpoint");
    const matchedBeCount = nonEmptyCount(pageFlow.bffToBeMatches, "beEndpoint");
    const uiApiCallCoverage = uiApiCallCount > 0 ? recordMentionCoverage(finalDoc, uiApiCalls, ["clientFunction", "path", "httpMethod"]) : null;
    const bffMatchCoverage = uiApiCallCount > 0 ? ratio(matchedBffCount, uiApiCallCount) : null;
    const beMatchCoverage = matchedBffCount > 0 ? ratio(matchedBeCount, matchedBffCount) : null;
    const beServiceFlows = asRecords(pageFlow.beServiceFlows);
    const trustedBeServiceFlowCount = beServiceFlows.filter((flow) => String(flow.confidence ?? "") !== "low").length;
    const serviceFlowCoverage = matchedBeCount > 0 ? ratio(trustedBeServiceFlowCount, matchedBeCount) : null;
    const repositoryEntityRecords = [...asRecords(pageFlow.repositories), ...asRecords(pageFlow.entities)];
    const repositoryEntityCoverage = trustedBeServiceFlowCount > 0
      ? (repositoryEntityRecords.length ? recordMentionCoverage(finalDoc, repositoryEntityRecords, ["repository", "method", "entity", "table"]) : 0)
      : null;
    const parameterRecords = collectParameterRecords(pageFlow);
    const parameterCoverage = parameterRecords.length ? recordMentionCoverage(finalDoc, parameterRecords, ["name", "field", "fieldOrParameter"]) : null;
    const validationRecords = asRecords(pageFlow.beValidations);
    const validationCoverage = validationRecords.length ? recordMentionCoverage(finalDoc, validationRecords, ["annotation", "fieldOrParameter", "className"]) : null;

    const coverageMetrics: Array<{ name: string; value: number | null; weight: number; reason: string }> = [
      { name: "ui-api-call-coverage", value: uiApiCallCoverage, weight: 6, reason: uiApiCallCount ? `${uiApiCallCount} indexed UI API calls were checked against document text.` : "No selected-page UI API calls are available." },
      { name: "bff-match-coverage", value: bffMatchCoverage, weight: 7, reason: uiApiCallCount ? `${matchedBffCount}/${uiApiCallCount} UI calls have a BFF endpoint.` : "BFF coverage has no UI API-call denominator." },
      { name: "be-match-coverage", value: beMatchCoverage, weight: 7, reason: matchedBffCount ? `${matchedBeCount}/${matchedBffCount} BFF matches have a BE endpoint.` : "BE coverage has no matched BFF denominator." },
      { name: "parameter-coverage", value: parameterCoverage, weight: 5, reason: parameterRecords.length ? `${parameterRecords.length} extracted form/endpoint parameter records were checked against document text.` : "No selected-page parameter evidence is available." },
      { name: "validation-coverage", value: validationCoverage, weight: 5, reason: validationRecords.length ? `${validationRecords.length} extracted validation records were checked against document text.` : "No selected-page validation evidence is available." },
      { name: "service-flow-coverage", value: serviceFlowCoverage, weight: 4, reason: matchedBeCount ? `${trustedBeServiceFlowCount}/${matchedBeCount} BE matches have non-low-confidence service flows.` : "Service-flow coverage has no matched BE denominator." },
      { name: "repository-entity-coverage", value: repositoryEntityCoverage, weight: 4, reason: trustedBeServiceFlowCount ? `${repositoryEntityRecords.length} trusted repository/entity records were checked against document text.` : "No trusted BE service flow is available." },
      {
        name: "qwen-semantic-coverage",
        value: qwenSemanticCoverage,
        weight: 2,
        reason: semanticUsage.disabled
          ? "Qwen semantics were intentionally disabled for the Copilot page flow."
          : semanticUsage.pageUsed
            ? (qwenFreshnessIssues ? "Qwen semantics were used but are stale." : "Fresh Qwen page semantics were used by the draft flow.")
            : semanticUsage.known
              ? "Qwen semantics are optional and were not used by the draft flow."
              : "Qwen semantic usage is unknown because draft-bound context-selection metadata is unavailable."
      }
    ];
    for (const metric of coverageMetrics) {
      if (metric.value === null) {
        metricsWithUnknownData.add(metric.name);
      }
    }

    const metricExplanations: PageQualityMetricExplanation[] = [
      {
        metric: "required-sections",
        status: finalDoc ? "measured" : "unknown",
        value: finalDoc ? requiredSectionsPresent / requiredSections.length : null,
        weight: 20,
        reason: `${requiredSectionsPresent}/${requiredSections.length} required sections are present.`
      },
      {
        metric: "source-references",
        status: finalDoc ? "measured" : "unknown",
        value: finalDoc ? Math.min(sourceReferenceCount / 10, 1) : null,
        weight: 12,
        reason: `${sourceReferenceCount} source-path references were found.`
      },
      {
        metric: "gap-count",
        status: gapsAvailable ? "measured" : "unknown",
        value: gapsAvailable ? 1 - Math.min(gaps.length / 10, 1) : null,
        weight: 12,
        reason: gapsAvailable ? `${gaps.length} unresolved gaps remain.` : "The gap report is unavailable."
      },
      {
        metric: "high-severity-gaps",
        status: gapsAvailable ? "measured" : "unknown",
        value: gapsAvailable ? 1 - Math.min(highSeverityGapCount / 3, 1) : null,
        weight: 8,
        reason: gapsAvailable ? `${highSeverityGapCount} high-severity gaps remain.` : "The gap report is unavailable."
      },
      ...coverageMetrics.map((metric) => ({
      metric: metric.name,
      status: metric.value === null ? "unknown" : "measured",
      value: metric.value,
      weight: metric.weight,
      reason: metric.reason
      } as PageQualityMetricExplanation)),
      {
        metric: "artifact-availability",
        status: "measured",
        value: (Number(contextPackAvailable) + Number(evidencePackAvailable)) / 2,
        weight: 3,
        reason: `Context pack: ${contextPackAvailable ? "available" : "missing"}; evidence pack: ${evidencePackAvailable ? "available" : "missing"}.`
      },
      {
        metric: "document-length",
        status: finalDoc ? "measured" : "unknown",
        value: finalDoc ? documentLengthScore(finalDocumentLength) : null,
        weight: 5,
        reason: `The scored document contains ${finalDocumentLength} characters.`
      },
      {
        metric: "artifact-freshness",
        status: "measured",
        value: Math.max(0, 1 - Math.min(outputFreshnessIssueCount / 5, 1)),
        weight: 0,
        reason: `${outputFreshnessIssueCount} output freshness issues apply as a deduction.`
      }
    ];

    const score = Math.max(0, Math.min(100, Math.round(
      (requiredSectionsPresent / requiredSections.length) * 20 +
      Math.min(sourceReferenceCount / 10, 1) * 12 +
      (gapsAvailable ? (1 - Math.min(gaps.length / 10, 1)) * 12 : 0) +
      (gapsAvailable ? (1 - Math.min(highSeverityGapCount / 3, 1)) * 8 : 0) +
      (uiApiCallCoverage ?? 0) * 6 +
      (bffMatchCoverage ?? 0) * 7 +
      (beMatchCoverage ?? 0) * 7 +
      (parameterCoverage ?? 0) * 5 +
      (validationCoverage ?? 0) * 5 +
      (serviceFlowCoverage ?? 0) * 4 +
      (repositoryEntityCoverage ?? 0) * 4 +
      (qwenSemanticCoverage ?? 0) * 2 +
      (evidencePackAvailable ? 2 : 0) +
      (contextPackAvailable ? 1 : 0) +
      documentLengthScore(finalDocumentLength) * 5 -
      Math.min(metricsWithUnknownData.size * 2, 12) -
      Math.min(outputFreshnessIssueCount * 2, 10)
    )));

    const metadata: PageArtifactMetadata = await buildPageArtifactMetadata(pageRoot, [
      "page-flow.json",
      "page-context-pack.md",
      "page-evidence-pack.md",
      "copilot-draft.md",
      "detected-gaps.json",
      "repaired-sections.md",
      "final-page-technical-analysis.md"
    ]);
    const result: PageDocumentQualityScore = {
      generatedAt: metadata.generatedAt,
      pipelineVersion: metadata.pipelineVersion,
      inputHash: metadata.inputHash,
      sourceArtifactModifiedTimes: metadata.sourceArtifactModifiedTimes,
      page: String(selectedPage?.pageName ?? path.basename(pageRoot)),
      route: selectedPage?.route ? String(selectedPage.route) : undefined,
      score,
      grade: grade(score),
      requiredSectionsPresent,
      requiredSectionsTotal: requiredSections.length,
      sourceReferenceCount,
      unresolvedGapCount: gaps.length,
      highSeverityGapCount,
      uiApiCallCoverage,
      bffMatchCoverage,
      beMatchCoverage,
      parameterCoverage,
      validationCoverage,
      serviceFlowCoverage,
      repositoryEntityCoverage,
      qwenSemanticCoverage,
      evidencePackAvailable,
      contextPackAvailable,
      finalDocumentLength,
      metricsWithUnknownData: [...metricsWithUnknownData],
      metricExplanations,
      outputFreshnessIssues: outputFreshnessIssueCount
    };
    await atomicWriteJson(path.join(pageRoot, "quality-score.json"), result);
    await appendQuality(multiRepoRoot, result);
    return result;
  }
}

function resolveSemanticUsage(
  selection: Record<string, unknown>,
  draft: string,
  pageArtifactAvailable: boolean,
  interactionArtifactAvailable: boolean
): { known: boolean; disabled: boolean; pageUsed: boolean; interactionUsed: boolean } {
  const generation = parseGenerationMetadata(draft);
  const qwenIterativeDraft = generation.pipeline?.startsWith("qwen3-") ?? false;
  if (qwenIterativeDraft && typeof generation.qwenSemanticArtifactsUsed === "boolean") {
    return {
      known: true,
      disabled: !generation.qwenSemanticArtifactsUsed,
      pageUsed: generation.qwenSemanticArtifactsUsed && pageArtifactAvailable,
      interactionUsed: generation.qwenSemanticArtifactsUsed && interactionArtifactAvailable
    };
  }
  if (qwenIterativeDraft || typeof selection.qwenSemanticArtifactsEnabled !== "boolean") {
    return {
      known: qwenIterativeDraft,
      disabled: false,
      pageUsed: qwenIterativeDraft && pageArtifactAvailable,
      interactionUsed: qwenIterativeDraft && interactionArtifactAvailable
    };
  }
  if (!selection.qwenSemanticArtifactsEnabled) {
    return { known: true, disabled: true, pageUsed: false, interactionUsed: false };
  }
  const usedFiles = new Set(asRecords(selection.parts)
    .filter((part) => part.status === "included" && Number(part.sentCharacters ?? 0) > 0)
    .map((part) => String(part.fileName ?? "")));
  return {
    known: true,
    disabled: false,
    pageUsed: pageArtifactAvailable && usedFiles.has("qwen-page-semantics.json"),
    interactionUsed: interactionArtifactAvailable && usedFiles.has("qwen-interaction-semantics.jsonl")
  };
}

function parseGenerationMetadata(markdown: string): { pipeline?: string; qwenSemanticArtifactsUsed?: boolean } {
  const match = markdown.match(/<!--\s*bank-spring-docs-generation\s+({[^\r\n]*})\s*-->/);
  if (!match) {
    return {};
  }
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    return {
      pipeline: parsed.pipeline === undefined ? undefined : String(parsed.pipeline),
      qwenSemanticArtifactsUsed: typeof parsed.qwenSemanticArtifactsUsed === "boolean"
        ? parsed.qwenSemanticArtifactsUsed
        : undefined
    };
  } catch {
    return {};
  }
}

async function appendQuality(multiRepoRoot: string, score: PageDocumentQualityScore): Promise<void> {
  const target = path.join(multiRepoRoot, "quality", "page-document-quality.jsonl");
  const existing = await readJsonl<PageDocumentQualityScore>(target);
  await writeJsonl(target, [...existing.filter((item) => item.page !== score.page || item.route !== score.route), score]);
}

function collectParameterRecords(pageFlow: Record<string, unknown>): Array<Record<string, unknown>> {
  const endpointParameters = [...asRecords(pageFlow.bffEndpoints), ...asRecords(pageFlow.beEndpoints)]
    .flatMap((endpoint) => asRecords(endpoint.parameters));
  return [...asRecords(pageFlow.formFields), ...endpointParameters];
}

function recordMentionCoverage(markdown: string, records: Array<Record<string, unknown>>, keys: string[]): number {
  if (!records.length) {
    return 0;
  }
  const normalizedDocument = markdown.toLowerCase();
  const mentioned = records.filter((record) => keys.some((key) => {
    const value = String(record[key] ?? "").trim().toLowerCase();
    if (value.length < 2) {
      return false;
    }
    return normalizedDocument.includes(value);
  })).length;
  return ratio(mentioned, records.length);
}

function ratio(value: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, value / total));
}

function nonEmptyCount(value: unknown, key: string): number {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && Boolean((item as Record<string, unknown>)[key])).length : 0;
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
}

function extractNormalizedHeadings(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/^#{1,3}\s+(.+)$/gm)].map((match) => normalizeHeading(match[1])));
}

function normalizeHeading(value: string): string {
  return foldToAscii(value)
    .replace(/^\s*\d+[\).\-\s]+/, "")
    .replace(/[^a-z0-9]/g, "");
}

function foldToAscii(value: string): string {
  return value
    .toLowerCase()
    .replace(/\u0131/g, "i")
    .replace(/\u011f/g, "g")
    .replace(/\u00fc/g, "u")
    .replace(/\u015f/g, "s")
    .replace(/\u00f6/g, "o")
    .replace(/\u00e7/g, "c")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function documentLengthScore(length: number): number {
  if (length < 2000) {
    return 0;
  }
  if (length < 6000) {
    return 0.5;
  }
  return 1;
}

function grade(score: number): PageDocumentQualityScore["grade"] {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function readJsonArray(filePath: string): Promise<Array<Record<string, unknown>>> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}
