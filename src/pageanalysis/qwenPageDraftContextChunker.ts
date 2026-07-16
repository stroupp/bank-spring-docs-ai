import * as fs from "fs/promises";
import * as path from "path";
import { maskSecretsWithStats } from "../ai/safeContextFilter";
import { selectPageEvidenceFiles } from "../evidence/pageEvidenceSelector";
import { MultiRepoManifest } from "../multirepo/multiRepoManifestService";
import { sha256 } from "../utils/hash";
import { ensureWithin, safeName } from "../utils/pathUtils";

export type QwenPageDraftChunkKind =
  | "page-flow"
  | "context-pack"
  | "evidence-pack"
  | "semantic-artifact"
  | "source-file";

export interface QwenPageDraftContextChunk {
  id: string;
  kind: QwenPageDraftChunkKind;
  sourceLabel: string;
  content: string;
  contentHash: string;
  characters: number;
  maskedSecrets: number;
  role?: "ui" | "bff" | "be";
  sourceFile?: string;
  part: number;
  partCount: number;
}

export interface QwenPageDraftContextChunkerOptions {
  /** Maximum evidence characters placed in a single model work item. */
  maxChunkCharacters: number;
  /** Maximum characters sampled from one selected raw source file. */
  maxSourceFileCharacters: number;
  /** Fairly divided UI/BFF/BE raw-source budget. */
  maxTotalSourceCharacters: number;
}

export interface QwenPageDraftContextBuildResult {
  chunks: QwenPageDraftContextChunk[];
  pageFlow: Record<string, unknown>;
  includedSourceFiles: string[];
  warnings: string[];
  maskedSecrets: number;
}

const artifactSpecs: Array<{ fileName: string; kind: QwenPageDraftChunkKind; format: "json" | "jsonl" | "markdown" }> = [
  { fileName: "page-flow.json", kind: "page-flow", format: "json" },
  { fileName: "page-context-pack.md", kind: "context-pack", format: "markdown" },
  { fileName: "page-evidence-pack.md", kind: "evidence-pack", format: "markdown" },
  { fileName: "qwen-page-semantics.json", kind: "semantic-artifact", format: "json" },
  { fileName: "qwen-interaction-semantics.jsonl", kind: "semantic-artifact", format: "jsonl" }
];

export class QwenPageDraftContextChunker {
  constructor(private readonly options: QwenPageDraftContextChunkerOptions) {
    requirePositiveInteger(options.maxChunkCharacters, "maxChunkCharacters");
    requirePositiveInteger(options.maxSourceFileCharacters, "maxSourceFileCharacters");
    requirePositiveInteger(options.maxTotalSourceCharacters, "maxTotalSourceCharacters");
  }

  async build(pageRoot: string, manifest?: MultiRepoManifest): Promise<QwenPageDraftContextBuildResult> {
    const chunks: QwenPageDraftContextChunk[] = [];
    const warnings: string[] = [];
    const includedSourceFiles: string[] = [];
    let pageFlow: Record<string, unknown> = {};

    for (const spec of artifactSpecs) {
      const filePath = path.join(pageRoot, spec.fileName);
      const content = await readOptional(filePath);
      if (!content) {
        if (spec.fileName === "page-flow.json" || spec.fileName === "page-context-pack.md") {
          warnings.push(`Required page artifact is missing or empty: ${spec.fileName}.`);
        }
        continue;
      }
      let canonicalContent: string;
      try {
        canonicalContent = canonicalizeArtifactContent(content, spec.format, filePath);
      } catch (error) {
        if (spec.fileName === "page-flow.json") {
          throw error;
        }
        warnings.push(`${spec.fileName} gecersiz oldugu icin Qwen3 context'ine eklenmedi: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (spec.fileName === "page-flow.json") {
        pageFlow = parseJsonRecord(canonicalContent, filePath);
      }
      const blocks = semanticArtifactBlocks(spec.fileName, canonicalContent, spec.format);
      chunks.push(...this.toChunks(spec.kind, spec.fileName, blocks));
    }

    if (!Object.keys(pageFlow).length) {
      throw new Error("Qwen3 sayfa taslagi icin page-flow.json bulunamadi veya gecersiz.");
    }

    if (manifest) {
      const source = await this.collectSelectedSources(manifest, pageFlow);
      chunks.push(...source.chunks);
      warnings.push(...source.warnings);
      includedSourceFiles.push(...source.includedSourceFiles);
    } else {
      warnings.push("MultiRepoManifest verilmedi; 30k evidence pack disindaki secili ham UI/BFF/BE kaynaklari eklenmedi.");
    }

    const deduplicated = deduplicateChunks(chunks);
    const safeWarnings = [...new Set(warnings.map(safeWarning).filter(Boolean))].sort();
    return {
      chunks: deduplicated,
      pageFlow,
      includedSourceFiles: [...new Set(includedSourceFiles)].sort(),
      warnings: safeWarnings,
      maskedSecrets: deduplicated.reduce((sum, chunk) => sum + chunk.maskedSecrets, 0)
    };
  }

  private toChunks(
    kind: QwenPageDraftChunkKind,
    sourceLabel: string,
    blocks: string[],
    source?: { role: "ui" | "bff" | "be"; file: string }
  ): QwenPageDraftContextChunk[] {
    const packed = packSemanticBlocks(blocks, this.options.maxChunkCharacters);
    return packed.map((content, index) => makeChunk({
      kind,
      sourceLabel,
      content,
      role: source?.role,
      sourceFile: source?.file,
      part: index + 1,
      partCount: packed.length
    }));
  }

  private async collectSelectedSources(
    manifest: MultiRepoManifest,
    pageFlow: Record<string, unknown>
  ): Promise<{ chunks: QwenPageDraftContextChunk[]; warnings: string[]; includedSourceFiles: string[] }> {
    const selections = selectPageEvidenceFiles(manifest, pageFlow);
    const chunks: QwenPageDraftContextChunk[] = [];
    const warnings: string[] = [];
    const includedSourceFiles: string[] = [];
    if (!selections.length) {
      return { chunks, warnings: ["Secili sayfa icin ham kaynak dosyasi referansi bulunamadi."], includedSourceFiles };
    }

    // Divide the global budget by role and then by file. This prevents a large
    // UI page from consuming the budget before later BFF and BE evidence is read.
    const roleBudget = Math.max(1, Math.floor(this.options.maxTotalSourceCharacters / selections.length));
    for (const selection of selections) {
      if (!selection.files.length) {
        continue;
      }
      const fileBudget = Math.max(1, Math.min(
        this.options.maxSourceFileCharacters,
        Math.floor(roleBudget / selection.files.length)
      ));
      for (const relativeFile of selection.files) {
        try {
          const bounded = await readContainedSource(selection.repoRoot, relativeFile, fileBudget);
          const label = `raw-source:${selection.role}:${relativeFile}`;
          const blocks = sourceFileBlocks(selection.role, relativeFile, bounded.content, bounded.truncated);
          chunks.push(...this.toChunks("source-file", label, blocks, { role: selection.role, file: relativeFile }));
          includedSourceFiles.push(`${selection.role}:${relativeFile}`);
          if (bounded.truncated) {
            warnings.push(`${selection.role}:${relativeFile} ${fileBudget} karakterlik adil dosya butcesiyle bas/son orneklenerek eklendi.`);
          }
        } catch (error) {
          warnings.push(`${selection.role}:${relativeFile} okunamadi: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      warnings.push(...selection.uncertaintyNotes.map((note) => `${selection.role}: ${note}`));
    }
    return { chunks, warnings, includedSourceFiles };
  }
}

/**
 * Rebuilt page artifacts contain operational timestamps and input digests that
 * change even when their evidence does not. Remove only those metadata values
 * before chunk hashing and before they are sent to Qwen, so an interrupted run
 * can resume without discarding meaningful page/source content.
 */
function canonicalizeArtifactContent(
  content: string,
  format: "json" | "jsonl" | "markdown",
  source: string
): string {
  if (format === "json") {
    const parsed = parseJsonRecord(content, source);
    const rootIsOperationalMetadata = path.basename(source).toLowerCase() === "page-flow.json" || looksLikeMetadataRecord(parsed);
    return `${JSON.stringify(canonicalizeJsonValue(parsed, rootIsOperationalMetadata), null, 2)}\n`;
  }
  if (format === "jsonl") {
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return JSON.stringify(canonicalizeJsonValue(parsed, looksLikeMetadataRecord(parsed)));
        } catch {
          return canonicalizeVolatileMetadataLines(line);
        }
      })
      .join("\n");
  }

  const normalized = canonicalizeVolatileMetadataLines(content);
  return normalized.replace(
    /(^##\s+(?:Artifact\s+)?Metadata\s*$[\s\S]*?^```json\s*$\n)([\s\S]*?)(\n^```\s*$)/gim,
    (match, opening: string, body: string, closing: string) => {
      try {
        const parsed = JSON.parse(body) as unknown;
        return `${opening}${JSON.stringify(canonicalizeJsonValue(parsed, true), null, 2)}${closing}`;
      } catch {
        return match;
      }
    }
  );
}

function canonicalizeJsonValue(value: unknown, metadataContext: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item, metadataContext));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const currentIsMetadata = metadataContext || looksLikeMetadataRecord(record);
  const entries = Object.entries(record).flatMap(([key, item]) => {
    if (currentIsMetadata && isVolatileMetadataKey(key)) {
      return [];
    }
    return [[key, canonicalizeJsonValue(item, isMetadataContainerKey(key))] as const];
  });
  return Object.fromEntries(entries);
}

function looksLikeMetadataRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value as Record<string, unknown>).map(normalizeMetadataKey);
  return keys.some((key) => key === "pipelineversion" || key === "sourceartifacts") &&
    keys.some((key) => key.endsWith("inputhash") || key === "generatedat");
}

function isMetadataContainerKey(key: string): boolean {
  const normalized = normalizeMetadataKey(key);
  return normalized === "metadata" || normalized.endsWith("metadata");
}

function isVolatileMetadataKey(key: string): boolean {
  const normalized = normalizeMetadataKey(key);
  return normalized === "generatedat" ||
    normalized === "updatedat" ||
    normalized === "startedat" ||
    normalized === "completedat" ||
    normalized.endsWith("inputhash");
}

function normalizeMetadataKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function canonicalizeVolatileMetadataLines(value: string): string {
  let insideFence = false;
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        insideFence = !insideFence;
        return line;
      }
      if (insideFence) {
        return line;
      }
      const match = line.match(/^(\s*(?:[-*]\s*)?(?:Olusturulma zamani|Generated(?:\s+at)?|Updated(?:\s+at)?|Started(?:\s+at)?|Completed(?:\s+at)?|Input\s+hash)\s*:\s*).*$/i);
      return match ? `${match[1]}[VOLATILE_METADATA_OMITTED]` : line;
    })
    .join("\n");
}

function safeWarning(value: string): string {
  const safe = maskSecretsWithStats(value).text.trim();
  const maxCharacters = 2000;
  return safe.length <= maxCharacters
    ? safe
    : `${safe.slice(0, maxCharacters - 35)} [WARNING_TEXT_TRUNCATED]`;
}

function semanticArtifactBlocks(fileName: string, content: string, format: "json" | "jsonl" | "markdown"): string[] {
  if (format === "markdown") {
    return markdownHeadingBlocks(fileName, content);
  }
  if (format === "jsonl") {
    const records = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return records.map((record, index) => `## ${fileName} record ${index + 1}\n${prettyJsonOrOriginal(record)}`);
  }
  const parsed = parseJsonRecord(content, fileName);
  return Object.entries(parsed).flatMap(([key, value]) => {
    if (Array.isArray(value)) {
      return value.length
        ? value.map((item, index) => `## ${fileName} / ${key} / record ${index + 1}\n${JSON.stringify(item, null, 2)}`)
        : [`## ${fileName} / ${key}\n[]`];
    }
    return [`## ${fileName} / ${key}\n${JSON.stringify(value, null, 2)}`];
  });
}

function markdownHeadingBlocks(fileName: string, content: string): string[] {
  const matches = [...content.matchAll(/^#{1,4}\s+.+$/gm)];
  if (!matches.length) {
    return [`## ${fileName}\n${content}`];
  }
  const blocks: string[] = [];
  if ((matches[0].index ?? 0) > 0) {
    blocks.push(`## ${fileName} / preamble\n${content.slice(0, matches[0].index).trim()}`);
  }
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index ?? 0;
    const end = matches[index + 1]?.index ?? content.length;
    blocks.push(`<!-- artifact:${fileName} -->\n${content.slice(start, end).trim()}`);
  }
  return blocks.filter((block) => block.trim());
}

function sourceFileBlocks(role: "ui" | "bff" | "be", relativeFile: string, content: string, truncated: boolean): string[] {
  const header = [
    `## Raw ${role.toUpperCase()} source evidence`,
    `- File: ${relativeFile}`,
    `- Sampling: ${truncated ? "bounded head and tail; middle omitted explicitly" : "complete selected file"}`
  ].join("\n");
  return splitByLines(content, 12000).map((part, index, all) => [
    header,
    `- Source part: ${index + 1}/${all.length}`,
    "```",
    part,
    "```"
  ].join("\n"));
}

function packSemanticBlocks(blocks: string[], maxCharacters: number): string[] {
  const atomic = blocks.flatMap((block) => block.length <= maxCharacters
    ? [block]
    : splitByLines(block, maxCharacters));
  const result: string[] = [];
  let current = "";
  for (const block of atomic) {
    if (!current) {
      current = block;
      continue;
    }
    const candidate = `${current}\n\n---\n\n${block}`;
    if (candidate.length <= maxCharacters) {
      current = candidate;
    } else {
      result.push(current);
      current = block;
    }
  }
  if (current) {
    result.push(current);
  }
  return result;
}

function splitByLines(value: string, maxCharacters: number): string[] {
  if (value.length <= maxCharacters) {
    return [value];
  }
  const result: string[] = [];
  let current = "";
  for (const line of value.split(/(?<=\n)/)) {
    if (line.length > maxCharacters) {
      if (current) {
        result.push(current);
        current = "";
      }
      for (let offset = 0; offset < line.length; offset += maxCharacters) {
        result.push(line.slice(offset, offset + maxCharacters));
      }
      continue;
    }
    if (current && current.length + line.length > maxCharacters) {
      result.push(current);
      current = line;
    } else {
      current += line;
    }
  }
  if (current) {
    result.push(current);
  }
  return result;
}

function makeChunk(input: {
  kind: QwenPageDraftChunkKind;
  sourceLabel: string;
  content: string;
  role?: "ui" | "bff" | "be";
  sourceFile?: string;
  part: number;
  partCount: number;
}): QwenPageDraftContextChunk {
  const safe = maskSecretsWithStats(input.content);
  const contentHash = sha256(safe.text);
  const stem = safeName(`${input.kind}-${input.sourceLabel}`) || "page-evidence";
  return {
    id: `${stem.slice(0, 70)}-${input.part}-${contentHash.slice(0, 12)}`,
    kind: input.kind,
    sourceLabel: input.sourceLabel,
    content: safe.text,
    contentHash,
    characters: safe.text.length,
    maskedSecrets: safe.maskedSecrets,
    role: input.role,
    sourceFile: input.sourceFile,
    part: input.part,
    partCount: input.partCount
  };
}

function deduplicateChunks(chunks: QwenPageDraftContextChunk[]): QwenPageDraftContextChunk[] {
  const seen = new Set<string>();
  return chunks.filter((chunk) => {
    const key = `${chunk.kind}:${chunk.sourceLabel}:${chunk.contentHash}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function readContainedSource(repoRoot: string, relativeFile: string, maxCharacters: number): Promise<{ content: string; truncated: boolean }> {
  const candidate = path.resolve(repoRoot, relativeFile);
  if (!ensureWithin(repoRoot, candidate)) {
    throw new Error("source path repository sinirinin disinda");
  }
  const [realRoot, realFile] = await Promise.all([fs.realpath(repoRoot), fs.realpath(candidate)]);
  if (!ensureWithin(realRoot, realFile)) {
    throw new Error("resolved source path repository sinirinin disinda");
  }
  const content = await fs.readFile(realFile, "utf8");
  if (content.length <= maxCharacters) {
    return { content, truncated: false };
  }
  const marker = "\n\n[QWEN3_SOURCE_MIDDLE_OMITTED_BY_PER_FILE_BUDGET]\n\n";
  if (maxCharacters <= marker.length + 2) {
    return { content: content.slice(Math.max(0, content.length - maxCharacters)), truncated: true };
  }
  const remaining = maxCharacters - marker.length;
  const head = Math.floor(remaining / 2);
  const tail = remaining - head;
  return {
    content: `${content.slice(0, head)}${marker}${content.slice(content.length - tail)}`,
    truncated: true
  };
}

function parseJsonRecord(content: string, source: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${source} JSON olarak okunamadi: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function prettyJsonOrOriginal(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}
