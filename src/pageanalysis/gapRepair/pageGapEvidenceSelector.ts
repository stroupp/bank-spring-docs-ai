import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { PageGapRepairPlan } from "./pageGapRepairPlanner";

export type PageRepairContextOptions = {
  mode: "qwen3-target-first";
  /** Exact ceiling for the returned repair context, including headings and separators. */
  maxCharacters: number;
} | {
  mode: "configured-provider";
  /** Provider-aware decision made by the caller; the Copilot-only toggle must not leak into Qwen. */
  includeQwenSemantics: boolean;
  /** Exact ceiling for the returned repair context, including headings and separators. */
  maxCharacters: number;
};

export async function buildRepairContext(
  pageRoot: string,
  plan: PageGapRepairPlan,
  options?: PageRepairContextOptions
): Promise<string> {
  if (options?.mode === "qwen3-target-first") {
    return buildQwen3TargetFirstContext(pageRoot, plan, options.maxCharacters);
  }

  const maxCharacters = options?.mode === "configured-provider"
    ? options.maxCharacters
    : vscode.workspace.getConfiguration("bankSpringDocs").get<number>("copilot.maxContextCharacters", 24000);
  const includeQwenSemantics = options?.mode === "configured-provider"
    ? options.includeQwenSemantics
    : true;
  const [draft, evidence, pageContext, pageSemantics, interactionSemantics] = await Promise.all([
    readFreshOptional(pageRoot, "copilot-draft.md", ["page-context-pack.md", "page-evidence-pack.md"]),
    readOptional(path.join(pageRoot, "page-evidence-pack.md")),
    readOptional(path.join(pageRoot, "page-context-pack.md")),
    includeQwenSemantics
      ? readFreshOptional(pageRoot, "qwen-page-semantics.json", ["page-context-pack.md", "page-evidence-pack.md"])
      : Promise.resolve(""),
    includeQwenSemantics
      ? readFreshOptional(pageRoot, "qwen-interaction-semantics.jsonl", ["page-context-pack.md", "page-evidence-pack.md", "page-flow.json"])
      : Promise.resolve("")
  ]);

  const fixed = [
    ["Detected Gaps", JSON.stringify(plan.gaps, null, 2)],
    ["Target Sections", plan.targetSections.map((section) => `- ${section}`).join("\n")],
    ["Suggested Evidence", plan.evidenceFiles.map((file) => `- ${file}`).join("\n")]
  ] as Array<[string, string]>;
  const prioritized = [
    ["Copilot Draft", selectRelevantMarkdown(draft, plan), 5],
    ["Page Evidence Pack", selectRelevantMarkdown(evidence, plan), 5],
    ["Page Context Pack", selectRelevantMarkdown(pageContext, plan), 3],
    ["Qwen Page Semantics", pageSemantics, 1],
    ["Qwen Interaction Semantics", interactionSemantics, 1]
  ] as Array<[string, string, number]>;

  return assembleWeightedContext(fixed, prioritized, maxCharacters);
}

async function buildQwen3TargetFirstContext(
  pageRoot: string,
  plan: PageGapRepairPlan,
  maxCharacters: number
): Promise<string> {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1000) {
    throw new Error("Qwen3 repair context budget must be an integer of at least 1000 characters.");
  }

  const qwenPlan = withoutQwenSemanticArtifacts(plan);
  const [draft, evidence, pageContext, pageFlow] = await Promise.all([
    readFreshOptional(pageRoot, "copilot-draft.md", ["page-context-pack.md", "page-evidence-pack.md"]),
    readOptional(path.join(pageRoot, "page-evidence-pack.md")),
    readOptional(path.join(pageRoot, "page-context-pack.md")),
    readOptional(path.join(pageRoot, "page-flow.json"))
  ]);

  const fixed = [
    ["Detected Gaps", JSON.stringify(qwenPlan.gaps, null, 2)],
    ["Target Sections", qwenPlan.targetSections.map((section) => `- ${section}`).join("\n")],
    ["Suggested Evidence", qwenPlan.evidenceFiles.map((file) => `- ${file}`).join("\n")]
  ] as Array<[string, string]>;
  const prioritized = [
    ["Current AI Draft - Target Sections", selectRelevantMarkdown(draft, qwenPlan), 5],
    ["Relevant Page Evidence", selectRelevantMarkdown(evidence, qwenPlan), 5],
    ["Page Flow", pageFlow, 3],
    ["Page Context Pack", selectRelevantMarkdown(pageContext, qwenPlan), 2]
  ] as Array<[string, string, number]>;

  return assembleWeightedContext(fixed, prioritized, maxCharacters);
}

function withoutQwenSemanticArtifacts(plan: PageGapRepairPlan): PageGapRepairPlan {
  const keep = (file: string) => !/^qwen-(?:page|interaction)-semantics\.(?:json|jsonl)$/i.test(path.basename(file));
  const gaps = plan.gaps.map((gap) => ({
    ...gap,
    suggestedEvidence: gap.suggestedEvidence.filter(keep)
  }));
  return {
    gaps,
    targetSections: [...plan.targetSections],
    evidenceFiles: plan.evidenceFiles.filter(keep)
  };
}

function assembleWeightedContext(
  fixed: Array<[string, string]>,
  prioritized: Array<[string, string, number]>,
  maxCharacters: number
): string {
  const separator = "\n\n---\n\n";
  const fixedText = fixed
    .filter(([, content]) => Boolean(content))
    .map(([title, content]) => `## ${title}\n${content}`)
    .join(separator);
  if (fixedText.length >= maxCharacters) {
    return boundedExcerpt(fixedText, maxCharacters, "REPAIR_TARGETS_TRUNCATED_FOR_TOKEN_LIMIT");
  }

  const available = prioritized.filter(([, content]) => Boolean(content));
  const rendered = fixedText ? [fixedText] : [];
  let remaining = maxCharacters - fixedText.length;
  let remainingWeight = available.reduce((total, [, , weight]) => total + weight, 0);

  for (let index = 0; index < available.length; index += 1) {
    const [title, content, weight] = available[index];
    if (rendered.length) {
      remaining -= separator.length;
    }
    const separatorsAfterThis = Math.max(0, available.length - index - 1) * separator.length;
    const usable = Math.max(0, remaining - separatorsAfterThis);
    const allocation = index === available.length - 1
      ? usable
      : Math.floor(usable * weight / Math.max(1, remainingWeight));
    const part = boundedSection(title, content, allocation);
    if (part) {
      rendered.push(part);
      remaining -= part.length;
    }
    remainingWeight -= weight;
  }

  const context = rendered.join(separator);
  return context.length <= maxCharacters
    ? context
    : boundedExcerpt(context, maxCharacters, "REPAIR_CONTEXT_TRUNCATED_FOR_TOKEN_LIMIT");
}

function boundedSection(title: string, content: string, maxCharacters: number): string {
  const prefix = `## ${title}\n`;
  if (maxCharacters <= prefix.length) {
    return "";
  }
  return `${prefix}${boundedExcerpt(content, maxCharacters - prefix.length, "SECTION_TRUNCATED_FOR_TOKEN_LIMIT")}`;
}

function boundedExcerpt(content: string, maxCharacters: number, marker: string): string {
  if (content.length <= maxCharacters) {
    return content;
  }
  const notice = `\n[${marker}]\n`;
  if (maxCharacters <= notice.length + 2) {
    return content.slice(0, maxCharacters);
  }
  const usable = maxCharacters - notice.length;
  const head = Math.ceil(usable * 0.75);
  return `${content.slice(0, head)}${notice}${content.slice(content.length - (usable - head))}`;
}

function selectRelevantMarkdown(content: string, plan: PageGapRepairPlan): string {
  if (!content.trim()) {
    return content;
  }
  const matches = [...content.matchAll(/^##\s+(.+)$/gm)];
  if (!matches.length) {
    return content;
  }
  const targetHeadings = new Set(plan.targetSections.map(normalizeHeading));
  const keywords = relevanceKeywords(plan);
  const selected: string[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const start = current.index ?? 0;
    const end = matches[index + 1]?.index ?? content.length;
    const section = content.slice(start, end).trim();
    const normalizedHeading = normalizeHeading(current[1]);
    const searchable = `${current[1]}\n${section.slice(0, 1200)}`.toLowerCase();
    if (
      targetHeadings.has(normalizedHeading) ||
      keywords.some((keyword) => searchable.includes(keyword))
    ) {
      selected.push(section);
    }
  }
  return selected.length ? selected.join("\n\n") : content;
}

function relevanceKeywords(plan: PageGapRepairPlan): string[] {
  const generic = new Set(["page", "evidence", "pack", "index", "jsonl", "markdown"]);
  const terms = [
    ...plan.targetSections.flatMap((section) => section.split(/[^A-Za-z0-9\u00c0-\u024f]+/)),
    ...plan.evidenceFiles.flatMap((file) => path.basename(file).split(/[^A-Za-z0-9]+/))
  ];
  return [...new Set(terms
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3 && !generic.has(term)))];
}

function normalizeHeading(value: string): string {
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

async function readFreshOptional(pageRoot: string, fileName: string, dependencies: string[]): Promise<string> {
  const staleDependencies = await staleDependenciesFor(pageRoot, fileName, dependencies);
  if (staleDependencies.length) {
    return `${fileName} skipped because it is older than: ${staleDependencies.join(", ")}. Regenerate it before using as repair context.`;
  }
  return readOptional(path.join(pageRoot, fileName));
}

async function staleDependenciesFor(pageRoot: string, fileName: string, dependencies: string[]): Promise<string[]> {
  const target = await statOptional(path.join(pageRoot, fileName));
  if (!target) {
    return [];
  }
  const stale: string[] = [];
  for (const dependency of dependencies) {
    const dependencyStat = await statOptional(path.join(pageRoot, dependency));
    if (dependencyStat && target.mtimeMs < dependencyStat.mtimeMs) {
      stale.push(dependency);
    }
  }
  return stale;
}

async function statOptional(filePath: string): Promise<{ mtimeMs: number } | undefined> {
  try {
    const stat = await fs.stat(filePath);
    return { mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}
