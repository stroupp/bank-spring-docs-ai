import { PageDocGap } from "../gapDetection/pageDocGapDetector";

export interface PageGapRepairPlan {
  gaps: PageDocGap[];
  evidenceFiles: string[];
  targetSections: string[];
}

const qwenActionableGapTypes = new Set<PageDocGap["gapType"]>([
  "empty-section",
  "missing-parameter",
  "missing-validation",
  "missing-bff-match",
  "missing-be-match",
  "missing-service-flow",
  "missing-repository-entity",
  "missing-source-reference"
]);

/**
 * Select only deterministic, evidence-repairable weaknesses for the Qwen-only
 * follow-up pass. An explicit uncertainty is not itself a defect: asking the
 * same model to rewrite `not-visible` or Belirsizlikler content usually adds a
 * call without adding evidence. Low-severity and generic prose findings are
 * likewise retained in detected-gaps.json for audit, but are not auto-repaired.
 * When the iterative pipeline supplies grounded section coverage, a candidate
 * must also have at least one finding tied to a validated source reference.
 */
export function selectGenuinelyWeakQwenGaps(
  gaps: readonly PageDocGap[],
  evidenceBackedSections?: readonly string[]
): PageDocGap[] {
  const grounded = evidenceBackedSections === undefined
    ? undefined
    : new Set(evidenceBackedSections.map(normalizeSection));
  return gaps
    .filter((gap) =>
      gap.severity !== "low"
      && gap.gapType !== "not-visible"
      && qwenActionableGapTypes.has(gap.gapType)
      && normalizeSection(gap.section) !== "belirsizlikler"
      && (grounded === undefined || grounded.has(normalizeSection(gap.section)))
    )
    .slice()
    .sort(compareQwenRepairPriority);
}

export function buildPageGapRepairPlan(gaps: readonly PageDocGap[]): PageGapRepairPlan {
  return {
    gaps: [...gaps],
    evidenceFiles: [...new Set(gaps.flatMap((gap) => gap.suggestedEvidence))].sort(),
    targetSections: [...new Set(gaps.map((gap) => gap.section))].sort()
  };
}

function compareQwenRepairPriority(left: PageDocGap, right: PageDocGap): number {
  const severity = severityPriority(left.severity) - severityPriority(right.severity);
  if (severity) {
    return severity;
  }
  const type = gapTypePriority(left.gapType) - gapTypePriority(right.gapType);
  if (type) {
    return type;
  }
  const section = normalizeSection(left.section).localeCompare(normalizeSection(right.section));
  return section || left.id.localeCompare(right.id);
}

function severityPriority(value: PageDocGap["severity"]): number {
  return value === "high" ? 0 : value === "medium" ? 1 : 2;
}

function gapTypePriority(value: PageDocGap["gapType"]): number {
  switch (value) {
    case "empty-section":
      return 0;
    case "missing-bff-match":
    case "missing-be-match":
      return 1;
    case "missing-service-flow":
    case "missing-repository-entity":
      return 2;
    case "missing-parameter":
    case "missing-validation":
      return 3;
    case "missing-source-reference":
      return 4;
    default:
      return 5;
  }
}

function normalizeSection(value: string): string {
  return value
    .toLowerCase()
    .replace(/\u0131/g, "i")
    .replace(/\u011f/g, "g")
    .replace(/\u00fc/g, "u")
    .replace(/\u015f/g, "s")
    .replace(/\u00f6/g, "o")
    .replace(/\u00e7/g, "c")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^\s*\d+[.)\-\s]+/, "")
    .replace(/[^a-z0-9]/g, "");
}
