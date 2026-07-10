import * as fs from "fs/promises";
import * as path from "path";
import { multiRepoSemanticPromptVersion } from "./crossLayerSemanticPrompts";
import { sha256 } from "../../utils/hash";
import { safeName } from "../../utils/pathUtils";

export type MultiRepoSemanticKind = "ui-interactions" | "page-flows";

export class MultiRepoSemanticCacheService {
  constructor(private readonly multiRepoRoot: string, private readonly model: string) {}

  buildCacheKey(identity: string, sourceHash: string): string {
    return sha256(`${multiRepoSemanticPromptVersion}:${this.model}:${identity}:${sourceHash}`);
  }

  async read(kind: MultiRepoSemanticKind, identity: string, cacheKey: string): Promise<unknown | undefined> {
    try {
      const content = await fs.readFile(this.pathFor(kind, identity, cacheKey), "utf8");
      return JSON.parse(content);
    } catch {
      return undefined;
    }
  }

  async write(kind: MultiRepoSemanticKind, identity: string, cacheKey: string, value: unknown): Promise<string> {
    const target = this.pathFor(kind, identity, cacheKey);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(value, null, 2), "utf8");
    return target;
  }

  private pathFor(kind: MultiRepoSemanticKind, identity: string, cacheKey: string): string {
    const folder = kind === "ui-interactions"
      ? path.join(this.multiRepoRoot, "ui", "semantic", "interactions")
      : path.join(this.multiRepoRoot, "traceability", "semantic", "page-flows");
    return path.join(folder, `${safeName(identity)}.${cacheKey}.json`);
  }
}
