import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { MultiRepoManifest } from "../multirepo/multiRepoManifestService";
import { sourceContextFromFiles } from "../docs/focusedSourceContext";
import { selectPageEvidenceFiles } from "./pageEvidenceSelector";
import { buildPageEvidenceSnippets, EvidenceSnippetGroup } from "./sourceSnippetExtractors";

export interface EvidencePackResult {
  evidencePackPath: string;
  includedFiles: string[];
}

export class EvidencePackBuilder {
  async build(pageRoot: string, manifest: MultiRepoManifest): Promise<EvidencePackResult> {
    const pageFlowPath = path.join(pageRoot, "page-flow.json");
    const pageFlow = JSON.parse(await fs.readFile(pageFlowPath, "utf8")) as Record<string, unknown>;
    const config = vscode.workspace.getConfiguration("bankSpringDocs");
    const includeSourceEvidence = config.get<boolean>("pageAnalysis.includeSourceEvidence", true);
    const maxEvidenceCharacters = config.get<number>("pageAnalysis.maxEvidenceCharacters", 30000);
    const maxSnippetCharacters = config.get<number>("pageAnalysis.maxSnippetCharacters", 5000);
    const evidencePackPath = path.join(pageRoot, "page-evidence-pack.md");

    if (!includeSourceEvidence) {
      await fs.writeFile(evidencePackPath, "# Sayfa Evidence Paketi\n\nKaynak kaniti ayarlardan kapali.\n", "utf8");
      return { evidencePackPath, includedFiles: [] };
    }

    const sections: string[] = [
      "# Sayfa Evidence Paketi",
      "",
      `Olusturulma zamani: ${new Date().toISOString()}`,
      `Page flow source: ${pageFlowPath}`,
      `Selected page: ${JSON.stringify(pageFlow.selectedPage ?? {})}`
    ];
    const includedFiles: string[] = [];
    const exact = await buildPageEvidenceSnippets(manifest, pageFlow, maxSnippetCharacters);
    const groups: EvidenceSnippetGroup[] = [
      "React Page Evidence",
      "React Interaction Evidence",
      "React API Client Evidence",
      "BFF Endpoint Evidence",
      "BFF Service / Outbound Client Evidence",
      "Backend Endpoint Evidence",
      "Backend Service Evidence",
      "Repository / Entity Evidence"
    ];
    for (const group of groups) {
      const snippets = exact.snippets.filter((item) => item.group === group);
      sections.push("", `## ${group}`);
      if (snippets.length) {
        for (const item of snippets) {
          sections.push(
            "",
            `### ${item.symbolName}`,
            `- File: ${item.file}`,
            `- Reason: ${item.reason}`,
            `- Confidence: ${item.confidence}`,
            "",
            "```",
            item.code,
            "```"
          );
          includedFiles.push(`${group}:${item.file}`);
        }
      } else {
        sections.push("Not visible from exact snippet extraction. Broad fallback evidence may still include relevant source.");
      }
    }

    const perRoleBudget = Math.max(5000, Math.floor(maxEvidenceCharacters / 3));
    const broadUncertainties: string[] = [];
    sections.push("", "## Broad Fallback Evidence");
    for (const selection of selectPageEvidenceFiles(manifest, pageFlow)) {
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

    await fs.writeFile(evidencePackPath, sections.join("\n"), "utf8");
    return { evidencePackPath, includedFiles };
  }
}
