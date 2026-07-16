import * as path from "path";
import { atomicWriteJson } from "./atomicFile";
import { repositoryUrlForArtifact } from "../utils/repositoryUrl";

export interface Manifest {
  repositoryUrl: string;
  repositoryName: string;
  branch: string;
  pipelineIdentity?: string;
  generatedAt: string;
  buildTool: string;
}

export class ManifestService {
  async write(aiDocsPath: string, manifest: Manifest): Promise<void> {
    await atomicWriteJson(path.join(aiDocsPath, "manifest.json"), {
      ...manifest,
      repositoryUrl: repositoryUrlForArtifact(manifest.repositoryUrl)
    });
  }
}
