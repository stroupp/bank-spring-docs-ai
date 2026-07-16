import * as vscode from "vscode";
import { PageCandidate } from "./pageListService";

const selectedPageKey = "bankSpringDocs.pageAnalysis.selectedPage";
const activePipelineIdentityKey = "bankSpringDocs.multiRepo.activePipelineIdentity";

export class SelectedPageStateService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getSelectedPage(): PageCandidate | undefined {
    const scoped = this.context.globalState.get<PageCandidate>(this.scopedKey());
    return scoped ?? this.context.globalState.get<PageCandidate>(selectedPageKey);
  }

  async saveSelectedPage(page: PageCandidate): Promise<void> {
    await this.context.globalState.update(this.scopedKey(), page);
    await this.context.globalState.update(selectedPageKey, undefined);
  }

  async clearSelectedPage(): Promise<void> {
    await Promise.all([
      this.context.globalState.update(this.scopedKey(), undefined),
      this.context.globalState.update(selectedPageKey, undefined)
    ]);
  }

  private scopedKey(): string {
    const pipelineIdentity = this.context.globalState.get<string>(activePipelineIdentityKey);
    return pipelineIdentity && /^[a-f0-9]{64}$/.test(pipelineIdentity)
      ? `${selectedPageKey}.${pipelineIdentity}`
      : selectedPageKey;
  }
}
