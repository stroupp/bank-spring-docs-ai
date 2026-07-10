import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { askCopilotWithUsage } from "../../ai/copilotClient";
import { maskSecretsWithStats } from "../../ai/safeContextFilter";
import { writeJsonl, readJsonl } from "../../storage/jsonlWriter";
import { PageDocGap } from "../gapDetection/pageDocGapDetector";
import { buildRepairContext } from "./pageGapEvidenceSelector";
import { buildPageGapRepairPlan } from "./pageGapRepairPlanner";

export interface PageSectionRepairResult {
  repairedContextPath: string;
  repairedSectionsPath: string;
  repairedGapCount: number;
}

export class PageSectionRegenerator {
  async repair(multiRepoRoot: string, pageRoot: string, token: vscode.CancellationToken): Promise<PageSectionRepairResult> {
    const gaps = JSON.parse(await fs.readFile(path.join(pageRoot, "detected-gaps.json"), "utf8")) as PageDocGap[];
    const plan = buildPageGapRepairPlan(gaps);
    const safe = maskSecretsWithStats(await buildRepairContext(pageRoot, plan));
    const repairedContextPath = path.join(pageRoot, "repaired-context-pack.md");
    const repairedSectionsPath = path.join(pageRoot, "repaired-sections.md");
    await fs.writeFile(repairedContextPath, safe.text, "utf8");

    const prompt = {
      instructions: `You are a senior enterprise software documentation repair agent.

Use only the provided repair context.
Regenerate only the target weak/missing sections.
Write Turkish Markdown.
Do not invent unsupported behavior.
If evidence is still insufficient, write "Provided context içinde net görünmüyor."
Include source references when visible.`,
      userPrompt: `Repair these page technical analysis sections.

Return Markdown only.

Repair context:
${safe.text}`,
      combinedText: "",
      profile: "backend-technical-deep-dive" as const
    };
    prompt.combinedText = `${prompt.instructions}\n\n${prompt.userPrompt}`;
    const response = await askCopilotWithUsage(prompt, token);
    await fs.writeFile(repairedSectionsPath, response.text, "utf8");
    await appendRepairAudit(multiRepoRoot, {
      timestamp: new Date().toISOString(),
      pageRoot,
      repairedGapCount: gaps.length,
      repairedContextPath: path.relative(multiRepoRoot, repairedContextPath),
      repairedSectionsPath: path.relative(multiRepoRoot, repairedSectionsPath),
      estimatedTotalTokens: response.usage.estimatedTotalTokens,
      maskedSecrets: safe.maskedSecrets
    });
    return { repairedContextPath, repairedSectionsPath, repairedGapCount: gaps.length };
  }
}

async function appendRepairAudit(multiRepoRoot: string, entry: unknown): Promise<void> {
  const target = path.join(multiRepoRoot, "gap-repair", "repair-audit.jsonl");
  const existing = await readJsonl<unknown>(target);
  await writeJsonl(target, [...existing, entry]);
}
