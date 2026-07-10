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
      ...asBullets(input.pageFlows.map((flow) => `${flow.page}${flow.route ? ` (${flow.route})` : ""}: ${flow.uiApiCall} -> ${flow.bffEndpoint ?? "BFF yok"} -> ${flow.beEndpoint ?? "BE yok"} (${flow.confidence})`)),
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
      "- BFF outbound-call indeksleri eklendiginde BFF -> BE eslesmeleri daha guclu hale gelir.",
      "- UI API client fonksiyon adlari ve endpoint path sabitleri netlestikce confidence artar.",
      "- Kismi akislari Qwen semantik fazinda dusuk confidence fallback olarak islemek uygun olur."
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

function asBullets(values: string[]): string[] {
  return values.length ? values.map((value) => `- ${value}`) : ["- Tespit edilmedi"];
}
