import * as fs from "fs/promises";
import * as path from "path";
import { sha256 } from "../utils/hash";
import { safeName } from "../utils/pathUtils";

export class SummaryCacheService {
  async getSummaryPath(aiDocsPath: string, relativeFile: string, content: string): Promise<string> {
    const hash = sha256(content);
    const fileName = `${safeName(relativeFile)}.${hash}.md`;
    return path.join(aiDocsPath, "summaries", "files", fileName);
  }

  async readIfExists(summaryPath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(summaryPath, "utf8");
    } catch {
      return undefined;
    }
  }
}
