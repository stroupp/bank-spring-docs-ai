import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { MultiRepoManifest } from "../multirepo/multiRepoManifestService";
import { sourceContextFromFiles } from "../docs/focusedSourceContext";
import { buildPageArtifactMetadata } from "../pageanalysis/pageArtifactMetadata";
import { selectPageEvidenceFiles } from "./pageEvidenceSelector";
import { buildPageEvidenceSnippets, EvidenceSnippet, EvidenceSnippetGroup } from "./sourceSnippetExtractors";
import { atomicWriteFile } from "../storage/atomicFile";

export interface EvidencePackResult {
  evidencePackPath: string;
  includedFiles: string[];
}

export class EvidencePackBuilder {
  async build(pageRoot: string, manifest: MultiRepoManifest): Promise<EvidencePackResult> {
    await fs.mkdir(pageRoot, { recursive: true });
    const pageFlowPath = path.join(pageRoot, "page-flow.json");
    const pageFlow = JSON.parse(await fs.readFile(pageFlowPath, "utf8")) as Record<string, unknown>;
    const config = vscode.workspace.getConfiguration("bankSpringDocs");
    const includeSourceEvidence = config.get<boolean>("pageAnalysis.includeSourceEvidence", true);
    const maxEvidenceCharacters = config.get<number>("pageAnalysis.maxEvidenceCharacters", 30000);
    const maxSnippetCharacters = config.get<number>("pageAnalysis.maxSnippetCharacters", 5000);
    const evidencePackPath = path.join(pageRoot, "page-evidence-pack.md");

    if (!includeSourceEvidence) {
      const metadata = await buildPageArtifactMetadata(pageRoot, ["page-flow.json", "page-context-pack.md"]);
      await atomicWriteFile(evidencePackPath, `# Page Evidence Pack\n\n## Metadata\n\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n\nKaynak kaniti ayarlardan kapali.\n`);
      return { evidencePackPath, includedFiles: [] };
    }

    const metadata = await buildPageArtifactMetadata(pageRoot, ["page-flow.json", "page-context-pack.md"]);
    const sections: string[] = [
      "# Page Evidence Pack",
      "",
      "## Metadata",
      "",
      "```json",
      JSON.stringify(metadata, null, 2),
      "```"
    ];
    const includedFiles: string[] = [];
    const exact = await buildPageEvidenceSnippets(manifest, pageFlow, maxSnippetCharacters);
    const groups: EvidenceSnippetGroup[] = [
      "React Page Evidence",
      "React Route Evidence",
      "React Interaction Evidence",
      "React API Client Evidence",
      "BFF Endpoint Evidence",
      "BFF Service Evidence",
      "BFF Outbound Client Evidence",
      "Backend Endpoint Evidence",
      "Backend Service Evidence",
      "Repository Evidence",
      "Entity / DTO / Validation Evidence"
    ];
    const exactBudget = Math.max(3000, Math.floor(maxEvidenceCharacters * 0.72));
    let exactCharacters = sections.join("\n").length;
    for (const group of groups) {
      const snippets = exact.snippets
        .filter((item) => item.group === group)
        .sort((left, right) => confidenceRank(right) - confidenceRank(left))
        .slice(0, 4);
      sections.push("", `## ${group}`);
      if (snippets.length) {
        for (const item of snippets) {
          const rendered = [
            "",
            `### ${item.symbolName}`,
            `- File: ${item.file}`,
            `- Reason: ${item.reason}`,
            `- Confidence: ${item.confidence}`,
            "",
            "```",
            item.code,
            "```"
          ];
          const characters = rendered.join("\n").length;
          if (exactCharacters + characters > exactBudget) {
            exact.uncertainties.push(`Exact evidence budget omitted ${group}: ${item.symbolName} (${item.file}).`);
            continue;
          }
          sections.push(...rendered);
          exactCharacters += characters;
          includedFiles.push(`${group}:${item.file}`);
        }
        if (!includedFiles.some((file) => file.startsWith(`${group}:`))) {
          sections.push("Exact snippets were found but omitted by the configured evidence budget.");
        }
      } else {
        sections.push("Not visible from exact snippet extraction. Broad fallback evidence may still include relevant source.");
      }
    }

    const selections = selectPageEvidenceFiles(manifest, pageFlow);
    const remainingBudget = Math.max(1000, maxEvidenceCharacters - sections.join("\n").length - 1200);
    const perRoleBudget = Math.max(1000, Math.floor(remainingBudget / Math.max(1, selections.length)));
    const broadUncertainties: string[] = [];
    sections.push("", "## Broad Fallback Evidence");
    for (const selection of selections) {
      const source = await sourceContextFromFiles(selection.repoRoot, selection.files, maxSnippetCharacters, perRoleBudget);
      sections.push("", `### ${selection.role.toUpperCase()} Kaynak Kanitlari`);
      if (selection.uncertaintyNotes.length) {
        broadUncertainties.push(...selection.uncertaintyNotes);
      }
      sections.push("", source.content || "Not visible from provided context.");
      includedFiles.push(...source.files.map((file) => `${selection.role}:${file}`));
    }

    const uncertainties = [...new Set([...exact.uncertainties, ...broadUncertainties])].sort();
    sections.push("", "## Uncertainties");
    sections.push(...(uncertainties.length ? uncertainties.map((note) => `- ${note}`) : ["- No exact-snippet uncertainty recorded."]));

    await atomicWriteFile(evidencePackPath, sections.join("\n"));
    return { evidencePackPath, includedFiles };
  }
}

function confidenceRank(snippet: EvidenceSnippet): number {
  return snippet.confidence === "high" ? 3 : snippet.confidence === "medium" ? 2 : 1;
}
