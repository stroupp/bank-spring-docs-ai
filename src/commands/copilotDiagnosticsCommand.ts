import * as vscode from "vscode";
import { askCopilotWithUsage } from "../ai/copilotClient";

export async function runCopilotDiagnosticsCommand(): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: Copilot tanılama testi",
      cancellable: true
    },
    async (progress, token) => {
      const nonce = `BANK-SPRING-DOCS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const prompt = [
        "You are GitHub Copilot Language Model API responding to a diagnostic request.",
        "Return exactly this JSON and nothing else:",
        JSON.stringify({ ok: true, nonce })
      ].join("\n");

      const response = await askCopilotWithUsage(prompt, token, (usage) => {
        progress.report({ message: `~${usage.estimatedTotalTokens} token tahmini, yanıt bekleniyor...` });
      });

      const matched = response.text.includes(nonce);
      const details = [
        `Copilot diagnostic ${matched ? "başarılı" : "başarısız"}.`,
        `Model: ${response.model.name} (${response.model.vendor}/${response.model.family})`,
        `Model id: ${response.model.id}`,
        `Max input tokens: ${response.model.maxInputTokens}`,
        `Nonce matched: ${matched}`,
        `Response: ${response.text.slice(0, 500)}`
      ].join("\n");

      if (matched) {
        vscode.window.showInformationMessage(`Bank Spring Docs: Copilot tanılama başarılı. Model: ${response.model.name}`);
      } else {
        vscode.window.showWarningMessage("Bank Spring Docs: Copilot yanıt verdi ama nonce beklenen şekilde dönmedi.");
      }

      const document = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: `# Copilot Tanılama Sonucu\n\n${details}\n`
      });
      await vscode.window.showTextDocument(document, { preview: false });
    }
  );
}
