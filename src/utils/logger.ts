import * as vscode from "vscode";

export class Logger {
  private readonly channel = vscode.window.createOutputChannel("Bank Spring Docs AI");

  info(message: string): void {
    this.channel.appendLine(`[info] ${message}`);
  }

  error(message: string, error?: unknown): void {
    this.channel.appendLine(`[error] ${message}`);
    if (error instanceof Error) {
      this.channel.appendLine(error.stack ?? error.message);
    } else if (error) {
      this.channel.appendLine(String(error));
    }
  }

  show(): void {
    this.channel.show();
  }
}
