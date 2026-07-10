import { PageDocGap } from "../gapDetection/pageDocGapDetector";

export interface PageGapRepairPlan {
  gaps: PageDocGap[];
  evidenceFiles: string[];
  targetSections: string[];
}

export function buildPageGapRepairPlan(gaps: PageDocGap[]): PageGapRepairPlan {
  return {
    gaps,
    evidenceFiles: [...new Set(gaps.flatMap((gap) => gap.suggestedEvidence))].sort(),
    targetSections: [...new Set(gaps.map((gap) => gap.section))].sort()
  };
}
