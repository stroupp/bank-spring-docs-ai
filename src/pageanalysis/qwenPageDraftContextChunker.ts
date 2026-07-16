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
  { fileName: "page-evidence-pack.md", kind: "evidence-pack", format: "markdown" }
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
        warnings.push(`Required page artifact is missing or empty: ${spec.fileName}.`);
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
      const blocks = artifactBlocks(spec.fileName, canonicalContent, spec.format);
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
          const blocks = sourceFileBlocks(
            selection.role,
            relativeFile,
            bounded.content,
            bounded.truncated,
            this.options.maxChunkCharacters
          );
          chunks.push(...this.toChunks("source-file", label, blocks, { role: selection.role, file: relativeFile }));
          includedSourceFiles.push(maskSecretsWithStats(`${selection.role}:${relativeFile}`).text);
          if (bounded.truncated) {
            warnings.push(maskSecretsWithStats(`${selection.role}:${relativeFile} ${fileBudget} karakterlik adil dosya butcesiyle bas/son orneklenerek eklendi.`).text);
          }
        } catch (error) {
          warnings.push(maskSecretsWithStats(`${selection.role}:${relativeFile} okunamadi: ${error instanceof Error ? error.message : String(error)}`).text);
        }
      }
      warnings.push(...selection.uncertaintyNotes.map((note) => maskSecretsWithStats(`${selection.role}: ${note}`).text));
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

function artifactBlocks(fileName: string, content: string, format: "json" | "jsonl" | "markdown"): string[] {
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

interface SourceEvidenceWindow {
  content: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  overlapCharacters: number;
  boundary: "structure" | "line" | "character" | "end-of-source";
}

// A larger, still bounded source window materially reduces map calls. The
// provider-derived chunk ceiling and wrapper reserve remain the final hard
// boundary; adaptive splitting handles a gateway that rejects an otherwise
// valid large window without permanently multiplying every normal run.
const maxSourceBodyCharacters = 60000;
const maxSourceOverlapCharacters = 800;

function sourceFileBlocks(
  role: "ui" | "bff" | "be",
  relativeFile: string,
  content: string,
  truncated: boolean,
  maxChunkCharacters: number
): string[] {
  const header = [
    `## Raw ${role.toUpperCase()} source evidence`,
    `- File: ${relativeFile}`,
    `- Sampling: ${truncated ? "bounded head and tail; middle omitted explicitly" : "complete selected file"}`
  ].join("\n");
  // Reserve enough room for deterministic range/overlap metadata and fences.
  // This keeps the complete source window intact when the generic block packer
  // applies the configured per-request budget later.
  const reservedWrapperCharacters = [
    header,
    "- Source window: 999999999999/999999999999",
    "- Evidence range: lines 999999999999-999999999999",
    "- Character range: 99999999999999999999-99999999999999999999 (end exclusive)",
    "- Split boundary: end-of-source",
    "- Overlap with previous source window: 999999999999 characters (context only; do not duplicate findings)",
    "```",
    "```"
  ].join("\n").length + 16;
  const bodyBudget = Math.max(1, Math.min(
    maxSourceBodyCharacters,
    maxChunkCharacters - reservedWrapperCharacters
  ));
  const normalized = content.replace(/\r\n?/g, "\n");
  const windows = splitSourceEvidence(normalized, bodyBudget);
  // Range metadata remains inside the hashed content. Repeated code bodies at
  // different source positions therefore cannot be collapsed as duplicates.
  return windows.map((window, index) => [
    header,
    `- Source window: ${index + 1}/${windows.length}`,
    `- Evidence range: lines ${window.startLine}-${window.endLine}`,
    `- Character range: ${window.startOffset}-${window.endOffset} (end exclusive)`,
    `- Split boundary: ${window.boundary}`,
    `- Overlap with previous source window: ${window.overlapCharacters} characters (context only; do not duplicate findings)`,
    "```",
    window.content,
    "```"
  ].join("\n"));
}

/**
 * Split sampled source before it is wrapped in Markdown. Windows prefer a
 * nearby code-structure boundary, then a line boundary, and use a raw
 * character boundary only for an oversized source line. A small overlap is
 * carried into the next window, but its exact range is disclosed so reducers
 * can treat it as context rather than a second finding.
 */
function splitSourceEvidence(value: string, maxCharacters: number): SourceEvidenceWindow[] {
  if (!value) {
    return [{
      content: "",
      startOffset: 0,
      endOffset: 0,
      startLine: 1,
      endLine: 1,
      overlapCharacters: 0,
      boundary: "end-of-source"
    }];
  }
  if (value.length <= maxCharacters) {
    return [{
      content: value,
      startOffset: 0,
      endOffset: value.length,
      startLine: 1,
      endLine: lineNumberAt(value, value.length, true),
      overlapCharacters: 0,
      boundary: "end-of-source"
    }];
  }

  const overlapBudget = maxCharacters >= 40
    ? Math.min(maxSourceOverlapCharacters, Math.max(1, Math.floor(maxCharacters * 0.1)))
    : 0;
  const breaks = sourceBreaks(value);
  const windows: SourceEvidenceWindow[] = [];
  let startOffset = 0;
  let coveredEnd = 0;

  while (coveredEnd < value.length) {
    const choice = chooseSourceWindowEnd(value.length, startOffset, coveredEnd, maxCharacters, breaks);
    const endOffset = choice.endOffset;
    windows.push({
      content: value.slice(startOffset, endOffset),
      startOffset,
      endOffset,
      startLine: lineNumberAt(value, startOffset, false),
      endLine: lineNumberAt(value, endOffset, true),
      overlapCharacters: Math.max(0, coveredEnd - startOffset),
      boundary: choice.boundary
    });
    if (endOffset >= value.length) {
      break;
    }
    coveredEnd = endOffset;
    startOffset = chooseSourceOverlapStart(startOffset, endOffset, overlapBudget, breaks.lineStarts);
  }
  return windows;
}

function sourceBreaks(value: string): {
  structural: number[];
  lines: number[];
  lineStarts: number[];
} {
  const structural: number[] = [];
  const lines: number[] = [];
  const lineStarts = [0];
  let lineStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\n") {
      continue;
    }
    const offset = index + 1;
    const line = value.slice(lineStart, offset);
    lines.push(offset);
    if (isSourceStructureBoundary(line)) {
      structural.push(offset);
    }
    if (offset < value.length) {
      lineStarts.push(offset);
    }
    lineStart = offset;
  }
  return { structural, lines, lineStarts };
}

function isSourceStructureBoundary(line: string): boolean {
  const trimmed = line.trim();
  return !trimmed
    || /^[}\])]+[;,]?$/.test(trimmed)
    || /^(?:end|fi|done)\b/i.test(trimmed);
}

function chooseSourceWindowEnd(
  valueLength: number,
  startOffset: number,
  coveredEnd: number,
  maxCharacters: number,
  breaks: { structural: number[]; lines: number[] }
): { endOffset: number; boundary: SourceEvidenceWindow["boundary"] } {
  const hardEnd = Math.min(valueLength, startOffset + maxCharacters);
  if (hardEnd >= valueLength) {
    return { endOffset: valueLength, boundary: "end-of-source" };
  }

  // Overlap must never prevent forward progress. Prefer a boundary in the
  // latter half of the window, but always require at least one new character.
  const minimumUsefulEnd = Math.max(coveredEnd + 1, startOffset + Math.floor(maxCharacters * 0.4));
  const structural = lastBreakWithin(breaks.structural, minimumUsefulEnd, hardEnd);
  if (structural !== undefined) {
    return { endOffset: structural, boundary: "structure" };
  }
  const line = lastBreakWithin(
    breaks.lines,
    Math.max(coveredEnd + 1, startOffset + Math.floor(maxCharacters * 0.25)),
    hardEnd
  );
  if (line !== undefined) {
    return { endOffset: line, boundary: "line" };
  }
  return { endOffset: hardEnd, boundary: "character" };
}

function lastBreakWithin(values: number[], minimum: number, maximum: number): number | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value > maximum) {
      continue;
    }
    return value >= minimum ? value : undefined;
  }
  return undefined;
}

function chooseSourceOverlapStart(
  previousStart: number,
  endOffset: number,
  overlapBudget: number,
  lineStarts: number[]
): number {
  if (overlapBudget <= 0) {
    return endOffset;
  }
  const minimum = Math.max(previousStart + 1, endOffset - overlapBudget);
  // Prefer whole-line overlap. If the window ended inside one oversized line,
  // fall back to an explicitly ranged character overlap.
  for (const lineStart of lineStarts) {
    if (lineStart >= minimum && lineStart < endOffset) {
      return lineStart;
    }
  }
  return Math.min(endOffset, minimum);
}

function lineNumberAt(value: string, offset: number, endExclusive: boolean): number {
  const target = endExclusive && offset > 0 ? offset - 1 : Math.min(offset, value.length);
  let line = 1;
  for (let index = 0; index < target; index += 1) {
    if (value[index] === "\n") {
      line += 1;
    }
  }
  return line;
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
  const safeLabel = maskSecretsWithStats(input.sourceLabel);
  const safeSourceFile = input.sourceFile ? maskSecretsWithStats(input.sourceFile) : undefined;
  const contentHash = sha256(safe.text);
  const stem = safeName(`${input.kind}-${safeLabel.text}`) || "page-evidence";
  return {
    id: `${stem.slice(0, 70)}-${input.part}-${contentHash.slice(0, 12)}`,
    kind: input.kind,
    sourceLabel: safeLabel.text,
    content: safe.text,
    contentHash,
    characters: safe.text.length,
    maskedSecrets: safe.maskedSecrets + safeLabel.maskedSecrets + (safeSourceFile?.maskedSecrets ?? 0),
    role: input.role,
    sourceFile: safeSourceFile?.text,
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
