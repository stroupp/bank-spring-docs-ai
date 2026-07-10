import * as vscode from "vscode";
import { PageCandidate } from "./pageListService";

const selectedPageKey = "bankSpringDocs.pageAnalysis.selectedPage";

export class SelectedPageStateService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getSelectedPage(): PageCandidate | undefined {
    return this.context.globalState.get<PageCandidate>(selectedPageKey);
  }

  async saveSelectedPage(page: PageCandidate): Promise<void> {
    await this.context.globalState.update(selectedPageKey, page);
  }

  async clearSelectedPage(): Promise<void> {
    await this.context.globalState.update(selectedPageKey, undefined);
  }
}
