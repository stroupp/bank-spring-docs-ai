import { BffToBeMatch } from "./bffToBeMatcher";
import { UiToBffMatch } from "./uiToBffMatcher";

export interface UnresolvedMatchRecord {
  layer: "ui-to-bff" | "bff-to-be";
  source: string;
  reason: string;
  confidence: string;
}

export class UnresolvedMatchReporter {
  build(uiToBff: UiToBffMatch[], bffToBe: BffToBeMatch[]): UnresolvedMatchRecord[] {
    return [
      ...uiToBff
        .filter((match) => match.confidence === "unmatched" || (match.confidence === "low" && /ambiguous/i.test(match.matchReason)))
        .map((match) => ({
          layer: "ui-to-bff" as const,
          source: match.uiApiCall,
          reason: match.matchReason,
          confidence: match.confidence
        })),
      ...bffToBe
        .filter((match) => match.confidence === "unmatched" || (match.confidence === "low" && /ambiguous/i.test(match.matchReason)))
        .map((match) => ({
          layer: "bff-to-be" as const,
          source: match.bffEndpoint,
          reason: match.matchReason,
          confidence: match.confidence
        }))
    ];
  }
}
