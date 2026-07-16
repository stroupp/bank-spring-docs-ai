import * as fs from "fs/promises";
import * as path from "path";
import { BffOutboundCallForTrace, BffToBeMatcher } from "../analyzer/traceability/bffToBeMatcher";
import {
  BeEntityForTrace,
  BeServiceFlowForTrace,
  PageFlowBuilder,
  UiInteractionForTrace,
  UiRouteForTrace
} from "../analyzer/traceability/pageFlowBuilder";
import { TraceabilityReportGenerator } from "../analyzer/traceability/traceabilityReportGenerator";
import { UiApiCallForTrace, SpringEndpointForTrace, UiToBffMatcher } from "../analyzer/traceability/uiToBffMatcher";
import { UnresolvedMatchReporter } from "../analyzer/traceability/unresolvedMatchReporter";
import { readRequiredJsonl, writeJsonl } from "../storage/jsonlWriter";
import { MultiRepoManifest } from "./multiRepoManifestService";
import { MultiRepoArtifactIdentityService } from "./multiRepoArtifactIdentityService";
import { atomicWriteFile, atomicWriteJson } from "../storage/atomicFile";
import { PipelineArtifactReceiptService } from "./pipelineArtifactReceiptService";

export interface MultiRepoTraceabilityResult {
  uiToBffMatches: number;
  bffToBeMatches: number;
  pageFlows: number;
  unresolved: number;
  reportPath: string;
}

export class MultiRepoTraceabilityService {
  async build(multiRepoRoot: string, manifest: MultiRepoManifest): Promise<MultiRepoTraceabilityResult> {
    await new MultiRepoArtifactIdentityService().assertCompatible(multiRepoRoot, manifest);
    const receiptService = new PipelineArtifactReceiptService();
    await receiptService.invalidateTraceability(multiRepoRoot);
    const traceabilityRoot = path.join(multiRepoRoot, "traceability");
    await fs.mkdir(traceabilityRoot, { recursive: true });
    const capturedInputs = await receiptService.captureInputs(multiRepoRoot);

    const uiApiCalls = await readRequiredJsonl<UiApiCallForTrace>(path.join(multiRepoRoot, "ui", "api-call-index.jsonl"), { validate: isUiApiCall });
    const uiInteractions = await readRequiredJsonl<UiInteractionForTrace>(path.join(multiRepoRoot, "ui", "interaction-index.jsonl"), { validate: isUiInteraction });
    const uiRoutes = await readRequiredJsonl<UiRouteForTrace>(path.join(multiRepoRoot, "ui", "route-index.jsonl"), { validate: isUiRoute });
    const bffEndpoints = await readRequiredJsonl<SpringEndpointForTrace>(path.join(multiRepoRoot, "bff", "api-endpoints.jsonl"), { validate: isSpringEndpoint });
    const bffOutboundCalls = await readRequiredJsonl<BffOutboundCallForTrace>(path.join(multiRepoRoot, "bff", "outbound-calls.jsonl"), { validate: isBffOutboundCall });
    const beEndpoints = await readRequiredJsonl<SpringEndpointForTrace>(path.join(multiRepoRoot, "be", "api-endpoints.jsonl"), { validate: isSpringEndpoint });
    const beServiceFlows = await readRequiredJsonl<BeServiceFlowForTrace>(path.join(multiRepoRoot, "be", "service-flow-index.jsonl"), { validate: isBeServiceFlow });
    const beEntities = await readRequiredJsonl<BeEntityForTrace>(path.join(multiRepoRoot, "be", "entity-index.jsonl"), { validate: isBeEntity });

    const uiToBff = new UiToBffMatcher().match(uiApiCalls, bffEndpoints);
    const bffToBe = new BffToBeMatcher().match(bffEndpoints, beEndpoints, bffOutboundCalls);
    const pageFlows = new PageFlowBuilder().build(uiToBff, bffToBe, uiInteractions, uiRoutes, beServiceFlows, beEntities);
    const unresolved = new UnresolvedMatchReporter().build(uiToBff, bffToBe);

    await writeJsonl(path.join(traceabilityRoot, "ui-to-bff.jsonl"), uiToBff);
    await writeJsonl(path.join(traceabilityRoot, "bff-to-be.jsonl"), bffToBe);
    await writeJsonl(path.join(traceabilityRoot, "page-flows.jsonl"), pageFlows);
    await writeJsonl(path.join(traceabilityRoot, "unresolved-matches.jsonl"), unresolved);

    const reportGenerator = new TraceabilityReportGenerator();
    const reportInput = {
      projectName: manifest.projectName,
      branch: manifest.branch,
      uiToBff,
      bffToBe,
      pageFlows,
      unresolved
    };
    const reportPath = path.join(traceabilityRoot, "traceability-report.md");
    await atomicWriteFile(reportPath, reportGenerator.buildMarkdown(reportInput));
    await atomicWriteJson(path.join(traceabilityRoot, "traceability-report.json"), reportGenerator.buildJson(reportInput));
    await receiptService.commitTraceability(multiRepoRoot, manifest, capturedInputs);

    return {
      uiToBffMatches: uiToBff.filter((match) => match.confidence !== "unmatched").length,
      bffToBeMatches: bffToBe.filter((match) => match.confidence !== "unmatched").length,
      pageFlows: pageFlows.length,
      unresolved: unresolved.length,
      reportPath
    };
  }
}

function isUiApiCall(value: unknown): value is UiApiCallForTrace {
  return isRecord(value) && hasStrings(value, ["httpMethod", "path", "file"]) &&
    optionalString(value.clientFunction) && optionalStringArray(value.usedBy);
}

function isUiInteraction(value: unknown): value is UiInteractionForTrace {
  return isRecord(value) && hasStrings(value, ["component", "label", "handler", "file"]) && optionalString(value.page);
}

function isUiRoute(value: unknown): value is UiRouteForTrace {
  return isRecord(value) && hasStrings(value, ["route", "pageComponent"]);
}

function isSpringEndpoint(value: unknown): value is SpringEndpointForTrace {
  return isRecord(value) && hasStrings(value, ["httpMethod", "path", "className", "handlerMethod", "file"]);
}

function isBffOutboundCall(value: unknown): value is BffOutboundCallForTrace {
  return isRecord(value) && hasStrings(value, ["client", "method", "httpMethod", "targetPath", "file"]) &&
    optionalString(value.sourceMethod) && optionalString(value.sourceEndpoint) &&
    optionalString(value.sourceController) && optionalString(value.sourceHandler) &&
    optionalStringArray(value.headers) && optionalString(value.bodyExpression);
}

function isBeServiceFlow(value: unknown): value is BeServiceFlowForTrace {
  return isRecord(value) && hasStrings(value, ["endpoint", "controller", "handler"]) &&
    stringArray(value.candidateServices) && stringArray(value.candidateRepositories) &&
    stringArray(value.entities) && stringArray(value.repositoryMethods) &&
    optionalStringArray(value.methodCalls) &&
    (value.confidence === "high" || value.confidence === "medium" || value.confidence === "low");
}

function isBeEntity(value: unknown): value is BeEntityForTrace {
  return isRecord(value) && hasStrings(value, ["entity"]) && optionalString(value.table);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasStrings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === "string" && Boolean((value[key] as string).trim()));
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
