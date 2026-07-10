import * as vscode from "vscode";
import { QwenClient } from "../ai/qwenClient";
import { QwenSettingsService, QwenSettingsUpdate } from "../ai/qwenSettingsService";

export async function saveQwenSettingsCommand(context: vscode.ExtensionContext, settings?: QwenSettingsUpdate): Promise<void> {
  const service = new QwenSettingsService(context);
  if (!settings) {
    vscode.window.showInformationMessage("Bank Spring Docs: Qwen ayarları panel üzerinden kaydedilebilir.");
    return;
  }
  await service.saveSettings(settings);
  vscode.window.showInformationMessage("Bank Spring Docs: Qwen ayarları kaydedildi.");
}

export async function testQwenConnectionCommand(context: vscode.ExtensionContext, settings?: QwenSettingsUpdate): Promise<void> {
  const service = new QwenSettingsService(context);
  if (settings) {
    await service.saveSettings(settings);
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Bank Spring Docs: Qwen bağlantısı test ediliyor",
      cancellable: false
    },
    async () => {
      const result = await new QwenClient(service).testConnection();
      if (result.ok) {
        vscode.window.showInformationMessage(`Bank Spring Docs: ${result.message}`);
      } else {
        vscode.window.showErrorMessage(`Bank Spring Docs: ${result.message}`);
      }
    }
  );
}
