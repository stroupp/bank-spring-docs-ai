import { BffToBeMatch } from "./bffToBeMatcher";
import { PageFlowRecord } from "./pageFlowBuilder";
import { UnresolvedMatchRecord } from "./unresolvedMatchReporter";
import { UiToBffMatch } from "./uiToBffMatcher";

export interface TraceabilityReportInput {
  projectName: string;
  branch: string;
  uiToBff: UiToBffMatch[];
  bffToBe: BffToBeMatch[];
  pageFlows: PageFlowRecord[];
  unresolved: UnresolvedMatchRecord[];
}

export class TraceabilityReportGenerator {
  buildMarkdown(input: TraceabilityReportInput): string {
    const fullFlows = input.pageFlows.filter((flow) => flow.bffEndpoint && flow.beEndpoint).length;
    const partialFlows = input.pageFlows.length - fullFlows;
    return [
      "# Uctan Uca Akis Eslesme Raporu",
      "",
      `Proje: ${input.projectName}`,
      `Branch: ${input.branch}`,
      `Olusturulma zamani: ${new Date().toISOString()}`,
      "",
      "## Ozet",
      `- UI -> BFF eslesme sayisi: ${input.uiToBff.filter((match) => match.confidence !== "unmatched").length}`,
      `- BFF -> BE eslesme sayisi: ${input.bffToBe.filter((match) => match.confidence !== "unmatched").length}`,
      `- Tam sayfa akisi: ${fullFlows}`,
      `- Kismi sayfa akisi: ${partialFlows}`,
      `- Eslesmeyen cagri: ${input.unresolved.length}`,
      "",
      "## UI -> BFF Eslesmeleri",
      ...asBullets(input.uiToBff.map((match) => `${match.uiApiCall} -> ${match.bffEndpoint ?? "Eslesmedi"} (${match.confidence}) - ${match.matchReason}`)),
      "",
      "## BFF -> BE Eslesmeleri",
      ...asBullets(input.bffToBe.map((match) => `${match.bffEndpoint} -> ${match.beEndpoint ?? "Eslesmedi"} (${match.confidence}) - ${match.matchReason}`)),
      "",
      "## Sayfa Akislari",
      ...asBullets(input.pageFlows.map((flow) => `${flow.page}${flow.route ? ` (${flow.route})` : ""}: ${flow.uiApiCall} -> ${flow.bffEndpoint ?? "BFF yok"} -> ${flow.beEndpoint ?? "BE yok"} (${flow.confidence})${flowEvidenceSummary(flow)}`)),
      "",
      "## Kismi Eslesmeler",
      ...asBullets(input.pageFlows.filter((flow) => flow.confidence === "partial").map((flow) => `${flow.page}: ${flow.uncertainties.join("; ")}`)),
      "",
      "## Eslesmeyen Cagrilar",
      ...asBullets(input.unresolved.map((item) => `${item.layer}: ${item.source} - ${item.reason}`)),
      "",
      "## Guven Skorlari",
      "- high: HTTP method ve normalize path birebir eslesti.",
      "- medium: Prefix/suffix farki normalize edilerek eslesti.",
      "- partial: Akisin en az bir katmani eksik kaldi.",
      "- unmatched: Lokal indekslerden eslesme bulunamadi.",
      "",
      "## Onerilen Aksiyonlar",
      ...asBullets(recommendedActions(input))
    ].join("\n");
  }

  buildJson(input: TraceabilityReportInput): unknown {
    return {
      projectName: input.projectName,
      branch: input.branch,
      generatedAt: new Date().toISOString(),
      summary: {
        uiToBffMatches: input.uiToBff.filter((match) => match.confidence !== "unmatched").length,
        bffToBeMatches: input.bffToBe.filter((match) => match.confidence !== "unmatched").length,
        pageFlows: input.pageFlows.length,
        unresolved: input.unresolved.length
      },
      uiToBff: input.uiToBff,
      bffToBe: input.bffToBe,
      pageFlows: input.pageFlows,
      unresolved: input.unresolved
    };
  }
}

function flowEvidenceSummary(flow: PageFlowRecord): string {
  const evidence: string[] = [];
  if (flow.beFlow.length) {
    evidence.push(`BE kaniti: ${summarize(flow.beFlow)}`);
  }
  if (flow.entities.length) {
    evidence.push(`entity: ${summarize(flow.entities)}`);
  }
  if (flow.tables.length) {
    evidence.push(`table: ${summarize(flow.tables)}`);
  }
  return evidence.length ? `; ${evidence.join("; ")}` : "";
}

function summarize(values: string[], limit = 4): string {
  const unique = [...new Set(values)];
  const visible = unique.slice(0, limit).join(", ");
  return unique.length > limit ? `${visible} (+${unique.length - limit})` : visible;
}

function recommendedActions(input: TraceabilityReportInput): string[] {
  const actions: string[] = [];
  if (input.uiToBff.some((match) => match.confidence === "unmatched" || match.confidence === "low")) {
    actions.push("Eslesmeyen UI cagrilari icin API client path sabitlerini ve cagri sahipligini netlestirin.");
  }
  if (input.bffToBe.some((match) => match.confidence === "unmatched" || match.confidence === "low")) {
    actions.push("Eslesmeyen BFF akislari icin outbound client hedeflerini ve method/path kanitini gozden gecirin.");
  }
  if (input.pageFlows.some((flow) => flow.confidence === "partial" || flow.uncertainties.length > 0)) {
    actions.push("Kismi sayfa akislarinda listelenen belirsizlikleri kaynak veya semantik analiz kanitiyla kapatin.");
  }
  if (!actions.length) {
    actions.push("Lokal deterministik eslemeler tamamlandi; yayinlamadan once is kurali ve yetki davranislarini alan sahibiyle dogrulayin.");
  }
  return actions;
}

function asBullets(values: string[]): string[] {
  return values.length ? values.map((value) => `- ${value}`) : ["- Tespit edilmedi"];
}
