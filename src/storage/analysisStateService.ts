import * as vscode from "vscode";

const lastAnalysisKey = "bankSpringDocs.lastAnalysis";

export interface LastAnalysisState {
  repoRoot: string;
  aiDocsPath: string;
  repositoryName: string;
  branch: string;
  updatedAt: string;
}

export class AnalysisStateService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getLastAnalysis(): LastAnalysisState | undefined {
    return this.context.globalState.get<LastAnalysisState>(lastAnalysisKey);
  }

  async setLastAnalysis(state: LastAnalysisState): Promise<void> {
    await this.context.globalState.update(lastAnalysisKey, state);
  }

  async clearLastAnalysis(): Promise<void> {
    await this.context.globalState.update(lastAnalysisKey, undefined);
  }
}
