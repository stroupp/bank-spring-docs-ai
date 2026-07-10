import * as fs from "fs/promises";
import * as path from "path";

export interface Manifest {
  repositoryUrl: string;
  repositoryName: string;
  branch: string;
  generatedAt: string;
  buildTool: string;
}

export class ManifestService {
  async write(aiDocsPath: string, manifest: Manifest): Promise<void> {
    await fs.writeFile(path.join(aiDocsPath, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  }
}
