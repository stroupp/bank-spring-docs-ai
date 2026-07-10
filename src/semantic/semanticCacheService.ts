import * as fs from "fs/promises";
import * as path from "path";
import { sha256 } from "../utils/hash";
import { safeName } from "../utils/pathUtils";
import { semanticPromptVersion } from "./qwenSemanticPrompts";

export type SemanticKind = "classes" | "endpoints" | "dependencies" | "modules";

export class SemanticCacheService {
  constructor(private readonly aiDocsPath: string, private readonly model: string) {}

  buildCacheKey(identity: string, sourceHash: string): string {
    return sha256(`${semanticPromptVersion}:${this.model}:${identity}:${sourceHash}`);
  }

  async read(kind: SemanticKind, identity: string, cacheKey: string): Promise<unknown | undefined> {
    try {
      const content = await fs.readFile(this.pathFor(kind, identity, cacheKey), "utf8");
      return JSON.parse(content);
    } catch {
      return undefined;
    }
  }

  async write(kind: SemanticKind, identity: string, cacheKey: string, value: unknown): Promise<string> {
    const target = this.pathFor(kind, identity, cacheKey);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(value, null, 2), "utf8");
    return target;
  }

  async writeDebug(identity: string, rawOutput: string): Promise<string> {
    const target = path.join(this.aiDocsPath, "semantic", "debug", `${safeName(identity)}-${Date.now()}.txt`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, rawOutput, "utf8");
    return target;
  }

  private pathFor(kind: SemanticKind, identity: string, cacheKey: string): string {
    return path.join(this.aiDocsPath, "semantic", kind, `${safeName(identity)}.${cacheKey}.json`);
  }
}

export function parseStrictJson(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error("Qwen JSON çıktısı parse edilemedi.");
  }
}
