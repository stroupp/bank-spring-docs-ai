import * as fs from "fs/promises";
import * as path from "path";
import { BffOutboundCallForTrace, BffToBeMatcher } from "../analyzer/traceability/bffToBeMatcher";
import { PageFlowBuilder, UiInteractionForTrace, UiRouteForTrace } from "../analyzer/traceability/pageFlowBuilder";
import { TraceabilityReportGenerator } from "../analyzer/traceability/traceabilityReportGenerator";
import { UiApiCallForTrace, SpringEndpointForTrace, UiToBffMatcher } from "../analyzer/traceability/uiToBffMatcher";
import { UnresolvedMatchReporter } from "../analyzer/traceability/unresolvedMatchReporter";
import { readJsonl, writeJsonl } from "../storage/jsonlWriter";
import { MultiRepoManifest } from "./multiRepoManifestService";

export interface MultiRepoTraceabilityResult {
  uiToBffMatches: number;
  bffToBeMatches: number;
  pageFlows: number;
  unresolved: number;
  reportPath: string;
}

export class MultiRepoTraceabilityService {
  async build(multiRepoRoot: string, manifest: MultiRepoManifest): Promise<MultiRepoTraceabilityResult> {
    const traceabilityRoot = path.join(multiRepoRoot, "traceability");
    await fs.mkdir(traceabilityRoot, { recursive: true });

    const uiApiCalls = await readJsonl<UiApiCallForTrace>(path.join(multiRepoRoot, "ui", "api-call-index.jsonl"));
    const uiInteractions = await readJsonl<UiInteractionForTrace>(path.join(multiRepoRoot, "ui", "interaction-index.jsonl"));
    const uiRoutes = await readJsonl<UiRouteForTrace>(path.join(multiRepoRoot, "ui", "route-index.jsonl"));
    const bffEndpoints = await readJsonl<SpringEndpointForTrace>(path.join(multiRepoRoot, "bff", "api-endpoints.jsonl"));
    const bffOutboundCalls = await readJsonl<BffOutboundCallForTrace>(path.join(multiRepoRoot, "bff", "outbound-calls.jsonl"));
    const beEndpoints = await readJsonl<SpringEndpointForTrace>(path.join(multiRepoRoot, "be", "api-endpoints.jsonl"));

    const uiToBff = new UiToBffMatcher().match(uiApiCalls, bffEndpoints);
    const bffToBe = new BffToBeMatcher().match(bffEndpoints, beEndpoints, bffOutboundCalls);
    const pageFlows = new PageFlowBuilder().build(uiToBff, bffToBe, uiInteractions, uiRoutes);
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
    await fs.writeFile(reportPath, reportGenerator.buildMarkdown(reportInput), "utf8");
    await fs.writeFile(path.join(traceabilityRoot, "traceability-report.json"), JSON.stringify(reportGenerator.buildJson(reportInput), null, 2), "utf8");

    return {
      uiToBffMatches: uiToBff.filter((match) => match.confidence !== "unmatched").length,
      bffToBeMatches: bffToBe.filter((match) => match.confidence !== "unmatched").length,
      pageFlows: pageFlows.length,
      unresolved: unresolved.length,
      reportPath
    };
  }
}
