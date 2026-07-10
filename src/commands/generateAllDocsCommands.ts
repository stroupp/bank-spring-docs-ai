import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { AnalysisQualityReportGenerator } from "../analyzer/analysisQualityReportGenerator";
import { CopilotAgenticDocumentationGenerator } from "../docs/copilotAgenticDocumentationGenerator";
import { CopilotDocumentationGenerator } from "../docs/copilotDocumentationGenerator";
import { LocalDocumentKind, LocalDocumentationGenerator } from "../docs/localDocumentationGenerator";
import { allLocalDocumentKinds, generateAllLocalDocs } from "../docs/localDocsBatchGenerator";
import { AnalysisStateService } from "../storage/analysisStateService";

const localKinds: LocalDocumentKind[] = [
  "repository-overview",
  "spring-architecture",
  "api-endpoints",
  "service-layer",
  "repository-layer",
  "entities",
  "configuration",
  "external-integrations",
  "test-analysis",
  "technical-analysis"
];

const copilotKinds: LocalDocumentKind[] = [
  "repository-overview",
  "spring-architecture",
  "api-endpoints",
  "service-layer",
  "configuration",
  "test-analysis",
  "technical-analysis"
];

export async function generateAllLocalDocsCommand(context: vscode.ExtensionContext): Promise<void> {
  const lastAnalysis = new AnalysisStateService(context).getLastAnalysis();
  if (!lastAnalysis) {
    vscode.window.showWarningMessage("Bank Spring Docs: Önce bir repository analizi çalıştırmalısın.");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: Tüm yerel dokümanlar oluşturuluyor",
      cancellable: false
    },
    async (progress) => {
      const generator = new LocalDocumentationGenerator();
      for (let index = 0; index < localKinds.length; index += 1) {
        progress.report({ message: `${localKinds[index]} oluşturuluyor...`, increment: 100 / (localKinds.length + 1) });
        await generator.generate(lastAnalysis.aiDocsPath, localKinds[index]);
      }
      await new AnalysisQualityReportGenerator().generate(lastAnalysis.aiDocsPath);
      vscode.window.showInformationMessage("Bank Spring Docs: Tüm yerel dokümanlar oluşturuldu.");
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(path.join(lastAnalysis.aiDocsPath, "generated-docs")));
    }
  );
}

export async function generateAllCopilotDocsCommand(context: vscode.ExtensionContext): Promise<void> {
  const lastAnalysis = new AnalysisStateService(context).getLastAnalysis();
  if (!lastAnalysis) {
    vscode.window.showWarningMessage("Bank Spring Docs: Önce bir repository analizi çalıştırmalısın.");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: Tüm Copilot dokümanları oluşturuluyor",
      cancellable: true
    },
    async (progress, token) => {
      const generator = new CopilotDocumentationGenerator();
      const failures: string[] = [];
      for (let index = 0; index < copilotKinds.length; index += 1) {
        if (token.isCancellationRequested) {
          break;
        }
        progress.report({ message: `${copilotKinds[index]} oluşturuluyor...`, increment: 100 / copilotKinds.length });
        try {
          await generator.generate(
            lastAnalysis.aiDocsPath,
            lastAnalysis.repositoryName,
            lastAnalysis.branch,
            copilotKinds[index],
            token,
            (message) => progress.report({ message })
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`${copilotKinds[index]}: ${message}`);
          progress.report({ message: `${copilotKinds[index]} başarısız, sıradaki dokümana geçiliyor...` });
        }
      }
      if (failures.length) {
        vscode.window.showWarningMessage(`Bank Spring Docs: Copilot doküman üretimi tamamlandı, ${failures.length} doküman başarısız. Context limitini düşürmeyi deneyin.`);
        return;
      }
      vscode.window.showInformationMessage("Bank Spring Docs: Copilot doküman üretimi tamamlandı.");
    }
  );
}

export async function generateAgenticCopilotBackendDocsCommand(context: vscode.ExtensionContext): Promise<void> {
  const lastAnalysis = new AnalysisStateService(context).getLastAnalysis();
  if (!lastAnalysis) {
    vscode.window.showWarningMessage("Bank Spring Docs: Önce bir repository analizi çalıştırmalısın.");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: Agentic Copilot analizi çalışıyor",
      cancellable: true
    },
    async (progress, token) => {
      const result = await new CopilotAgenticDocumentationGenerator().generate(
        lastAnalysis.aiDocsPath,
        lastAnalysis.repositoryName,
        lastAnalysis.branch,
        token,
        (event) => progress.report({
          message: event.message,
          increment: event.phase === "started" ? 100 / 6 : 0
        })
      );
      const document = await vscode.workspace.openTextDocument(result.finalDocumentPath);
      await vscode.window.showTextDocument(document, { preview: false });
      const action = await vscode.window.showInformationMessage(
        `Bank Spring Docs: Agentic Copilot tamamlandi. ${result.requestCount} istek, yaklasik ${result.estimatedTotalTokens} token.`,
        "Final Dokumani Ac",
        "Ara Ciktilari Ac",
        "Audit Log Ac"
      );
      if (action === "Final Dokumani Ac") {
        const finalDocument = await vscode.workspace.openTextDocument(result.finalDocumentPath);
        await vscode.window.showTextDocument(finalDocument, { preview: false });
      }
      if (action === "Ara Ciktilari Ac") {
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(result.workspaceRoot));
      }
      if (action === "Audit Log Ac") {
        await openCopilotAuditLogCommand(context);
      }
    }
  );
}

export async function openLastCopilotContextCommand(context: vscode.ExtensionContext): Promise<void> {
  const lastAnalysis = new AnalysisStateService(context).getLastAnalysis();
  if (!lastAnalysis) {
    vscode.window.showWarningMessage("Bank Spring Docs: Önce bir repository analizi çalıştırmalısın.");
    return;
  }
  const document = await vscode.workspace.openTextDocument(path.join(lastAnalysis.aiDocsPath, "context-packs", "last-copilot-context.md"));
  await vscode.window.showTextDocument(document, { preview: false });
}

export async function openLastCopilotPromptCommand(context: vscode.ExtensionContext): Promise<void> {
  const lastAnalysis = new AnalysisStateService(context).getLastAnalysis();
  if (!lastAnalysis) {
    vscode.window.showWarningMessage("Bank Spring Docs: Önce bir repository analizi çalıştırmalısın.");
    return;
  }
  const document = await vscode.workspace.openTextDocument(path.join(lastAnalysis.aiDocsPath, "context-packs", "last-copilot-prompt.md"));
  await vscode.window.showTextDocument(document, { preview: false });
}

export async function openCopilotAuditLogCommand(context: vscode.ExtensionContext): Promise<void> {
  const lastAnalysis = new AnalysisStateService(context).getLastAnalysis();
  if (!lastAnalysis) {
    vscode.window.showWarningMessage("Bank Spring Docs: Önce bir repository analizi çalıştırmalısın.");
    return;
  }
  const document = await vscode.workspace.openTextDocument(path.join(lastAnalysis.aiDocsPath, "audit", "copilot-requests.jsonl"));
  await vscode.window.showTextDocument(document, { preview: false });
}

export async function openLastCopilotContextSelectionCommand(context: vscode.ExtensionContext): Promise<void> {
  const lastAnalysis = new AnalysisStateService(context).getLastAnalysis();
  if (!lastAnalysis) {
    vscode.window.showWarningMessage("Bank Spring Docs: Önce bir repository analizi çalıştır.");
    return;
  }

  const dir = path.join(lastAnalysis.aiDocsPath, "audit", "context-selection");
  try {
    const files = await fs.readdir(dir);
    const latest = files.filter((file) => file.endsWith(".json")).sort().at(-1);
    if (!latest) {
      vscode.window.showWarningMessage("Bank Spring Docs: Context selection audit bulunamadı.");
      return;
    }
    const document = await vscode.workspace.openTextDocument(path.join(dir, latest));
    await vscode.window.showTextDocument(document, { preview: false });
  } catch {
    vscode.window.showWarningMessage("Bank Spring Docs: Context selection audit bulunamadı.");
  }
}
