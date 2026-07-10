import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { PageGapRepairPlan } from "./pageGapRepairPlanner";

export async function buildRepairContext(pageRoot: string, plan: PageGapRepairPlan): Promise<string> {
  const parts = [
    ["Detected Gaps", JSON.stringify(plan.gaps, null, 2)],
    ["Target Sections", plan.targetSections.map((section) => `- ${section}`).join("\n")],
    ["Suggested Evidence", plan.evidenceFiles.map((file) => `- ${file}`).join("\n")],
    ["Page Context Pack", await readOptional(path.join(pageRoot, "page-context-pack.md"))],
    ["Page Evidence Pack", await readOptional(path.join(pageRoot, "page-evidence-pack.md"))],
    ["Qwen Page Semantics", await readFreshOptional(pageRoot, "qwen-page-semantics.json", ["page-context-pack.md", "page-evidence-pack.md"])],
    ["Qwen Interaction Semantics", await readFreshOptional(pageRoot, "qwen-interaction-semantics.jsonl", ["page-context-pack.md", "page-evidence-pack.md", "page-flow.json"])],
    ["Copilot Draft", await readFreshOptional(pageRoot, "copilot-draft.md", ["page-context-pack.md", "page-evidence-pack.md"])]
  ];
  const context = parts
    .filter(([, content]) => Boolean(content))
    .map(([title, content]) => `## ${title}\n${content}`)
    .join("\n\n---\n\n");
  const maxCharacters = vscode.workspace.getConfiguration("bankSpringDocs").get<number>("copilot.maxContextCharacters", 24000);
  return context.length <= maxCharacters ? context : `${context.slice(0, maxCharacters)}\n[REPAIR_CONTEXT_TRUNCATED_FOR_TOKEN_LIMIT]`;
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
