import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { readJsonl } from "../storage/jsonlWriter";
import { LocalDocumentKind } from "../docs/localDocumentationGenerator";

export class ContextPackBuilder {
  async buildFromRepoMap(aiDocsPath: string): Promise<string> {
    return fs.readFile(path.join(aiDocsPath, "repo-map.md"), "utf8");
  }

  async buildForDocument(aiDocsPath: string, kind: LocalDocumentKind): Promise<string> {
    return (await this.buildForDocumentWithMetadata(aiDocsPath, kind)).content;
  }

  async buildForDocumentWithMetadata(aiDocsPath: string, kind: LocalDocumentKind): Promise<{ content: string; includedIndexes: string[]; contextSelection: ContextSelectionAudit }> {
    const repoMap = await readOptional(path.join(aiDocsPath, "repo-map.md"));
    const enrichedRepoMap = await readOptional(path.join(aiDocsPath, "enriched", "enriched-repo-map.md"));
    const manifest = await readOptional(path.join(aiDocsPath, "manifest.json"));
    const includedIndexes = ["manifest.json", "repo-map.md"];
    const sections = [
      section("Manifest", truncate(manifest, 3000)),
      section("Compact Repo Map", truncate(repoMap, 12000))
    ];
    if (enrichedRepoMap) {
      sections.push(section("Enriched Repo Map", truncate(enrichedRepoMap, 16000)));
      includedIndexes.push("enriched/enriched-repo-map.md");
    }

    const enrichedComponents = await readOptional(path.join(aiDocsPath, "enriched", "enriched-components.jsonl"));
    const enrichedEndpoints = await readOptional(path.join(aiDocsPath, "enriched", "enriched-endpoints.jsonl"));
    const enrichedDependencies = await readOptional(path.join(aiDocsPath, "enriched", "enriched-dependencies.jsonl"));
    if (enrichedComponents && (kind === "repository-overview" || kind === "spring-architecture" || kind === "service-layer" || kind === "repository-layer" || kind === "technical-analysis")) {
      sections.push(section("Qwen Semantic Component Explanations", truncate(enrichedComponents, 14000)));
      includedIndexes.push("enriched/enriched-components.jsonl");
    }
    if (enrichedEndpoints && (kind === "api-endpoints" || kind === "repository-overview" || kind === "technical-analysis")) {
      sections.push(section("Qwen Semantic Endpoint Explanations", truncate(enrichedEndpoints, 12000)));
      includedIndexes.push("enriched/enriched-endpoints.jsonl");
    }
    if (enrichedDependencies && (kind === "spring-architecture" || kind === "service-layer" || kind === "repository-layer" || kind === "technical-analysis")) {
      sections.push(section("Qwen Semantic Dependency Explanations", truncate(enrichedDependencies, 12000)));
      includedIndexes.push("enriched/enriched-dependencies.jsonl");
    }

    if (kind === "repository-overview" || kind === "spring-architecture" || kind === "technical-analysis") {
      sections.push(await jsonlSection(aiDocsPath, "spring-components.jsonl", 12000));
      sections.push(await jsonlSection(aiDocsPath, "dependency-graph.jsonl", 12000));
      sections.push(await jsonlSection(aiDocsPath, "module-map.json", 6000, false));
      includedIndexes.push("spring-components.jsonl", "dependency-graph.jsonl", "module-map.json");
    }

    if (kind === "api-endpoints" || kind === "repository-overview" || kind === "technical-analysis") {
      sections.push(await jsonlSection(aiDocsPath, "api-endpoints.jsonl", 12000));
      includedIndexes.push("api-endpoints.jsonl");
    }

    if (kind === "service-layer") {
      sections.push(await filteredJsonlSection(aiDocsPath, "spring-components.jsonl", "Service Components", (record) => record.type === "service"));
      sections.push(await filteredJsonlSection(aiDocsPath, "dependency-graph.jsonl", "Service Dependencies", (record) => String(record.relation).includes("service") || /Service$/.test(String(record.from))));
      includedIndexes.push("spring-components.jsonl", "dependency-graph.jsonl");
    }

    if (kind === "repository-layer") {
      sections.push(await filteredJsonlSection(aiDocsPath, "spring-components.jsonl", "Repository Components", (record) => record.type === "repository"));
      sections.push(await filteredJsonlSection(aiDocsPath, "dependency-graph.jsonl", "Repository Dependencies", (record) => String(record.relation).includes("repository") || /Repository$/.test(String(record.from)) || /Repository$/.test(String(record.to))));
      includedIndexes.push("spring-components.jsonl", "dependency-graph.jsonl");
    }

    if (kind === "entities" || kind === "repository-layer" || kind === "technical-analysis") {
      sections.push(await jsonlSection(aiDocsPath, "entity-index.jsonl", 12000));
      includedIndexes.push("entity-index.jsonl");
    }

    if (kind === "configuration" || kind === "external-integrations" || kind === "technical-analysis") {
      sections.push(await jsonlSection(aiDocsPath, "configuration-index.jsonl", 10000));
      includedIndexes.push("configuration-index.jsonl");
    }

    if (kind === "external-integrations") {
      sections.push(await filteredJsonlSection(aiDocsPath, "spring-components.jsonl", "Client Components", (record) => record.type === "client"));
      includedIndexes.push("spring-components.jsonl");
    }

    if (kind === "test-analysis" || kind === "technical-analysis") {
      sections.push(await jsonlSection(aiDocsPath, "test-index.jsonl", 10000));
      includedIndexes.push("test-index.jsonl");
    }

    if (kind === "technical-analysis") {
      sections.push(await jsonlSection(aiDocsPath, "file-index.jsonl", 10000));
      includedIndexes.push("file-index.jsonl");
    }

    const generatedDoc = await generatedDocSection(aiDocsPath, kind);
    if (generatedDoc) {
      sections.push(generatedDoc.content);
      includedIndexes.push(generatedDoc.relativePath);
    }

    const qualityReport = await readOptional(path.join(aiDocsPath, "analysis-report.md"));
    if (qualityReport && (kind === "repository-overview" || kind === "technical-analysis")) {
      sections.push(section("Local Analysis Quality Report", truncate(qualityReport, 10000)));
      includedIndexes.push("analysis-report.md");
    }

    const maxContextCharacters = vscode.workspace.getConfiguration("bankSpringDocs").get<number>("copilot.maxContextCharacters", 24000);
    const budgeted = applyContextBudget(sections.filter(Boolean).join("\n\n"), maxContextCharacters);
    return {
      content: budgeted.content,
      includedIndexes: [...new Set(includedIndexes)],
      contextSelection: budgeted.audit
    };
  }
}

async function generatedDocSection(aiDocsPath: string, kind: LocalDocumentKind): Promise<{ content: string; relativePath: string } | undefined> {
  const relativePath = path.join("generated-docs", generatedDocFileName(kind));
  const content = await readOptional(path.join(aiDocsPath, relativePath));
  if (!content) {
    return undefined;
  }
  return {
    relativePath,
    content: section(`Local Generated Document - ${kind}`, truncate(content, 12000))
  };
}

function generatedDocFileName(kind: LocalDocumentKind): string {
  switch (kind) {
    case "repository-overview":
      return "repository-overview.md";
    case "spring-architecture":
      return "spring-architecture.md";
    case "api-endpoints":
      return "api-endpoints.md";
    case "service-layer":
      return "service-layer.md";
    case "repository-layer":
      return "repository-layer.md";
    case "entities":
      return "database-entities.md";
    case "configuration":
      return "configuration.md";
    case "external-integrations":
      return "external-integrations.md";
    case "test-analysis":
      return "test-analysis.md";
    case "technical-analysis":
      return "technical-analysis.md";
  }
}

export interface ContextSelectionEntry {
  title: string;
  originalCharacters: number;
  selectedCharacters: number;
  truncated: boolean;
}

export interface ContextSelectionAudit {
  maxContextCharacters: number;
  originalCharacters: number;
  selectedCharacters: number;
  estimatedInputTokens: number;
  sections: ContextSelectionEntry[];
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function jsonlSection(aiDocsPath: string, fileName: string, maxCharacters: number, parseJsonl = true): Promise<string> {
  const filePath = path.join(aiDocsPath, fileName);
  if (!parseJsonl) {
    return section(fileName, truncate(await readOptional(filePath), maxCharacters));
  }
  const records = await readJsonl<unknown>(filePath);
  return section(fileName, truncate(records.map((record) => JSON.stringify(record)).join("\n"), maxCharacters));
}

async function filteredJsonlSection(
  aiDocsPath: string,
  fileName: string,
  title: string,
  predicate: (record: Record<string, unknown>) => boolean
): Promise<string> {
  const records = await readJsonl<Record<string, unknown>>(path.join(aiDocsPath, fileName));
  const content = records.filter(predicate).map((record) => JSON.stringify(record)).join("\n");
  return section(title, truncate(content, 12000));
}

function section(title: string, content: string): string {
  return `## ${title}\n${content || "Not visible from provided context."}`;
}

function truncate(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) {
    return value;
  }
  return `${value.slice(0, maxCharacters)}\n[TRUNCATED_FOR_TOKEN_BUDGET]`;
}

function applyContextBudget(value: string, maxCharacters: number): { content: string; audit: ContextSelectionAudit } {
  const parsedSections = splitSections(value);
  let remaining = maxCharacters;
  const selected: string[] = [];
  const auditSections: ContextSelectionEntry[] = [];

  for (const current of parsedSections) {
    if (remaining <= 0) {
      auditSections.push({
        title: current.title,
        originalCharacters: current.content.length,
        selectedCharacters: 0,
        truncated: true
      });
      continue;
    }

    const separator = selected.length ? "\n\n" : "";
    const available = Math.max(0, remaining - separator.length);
    const selectedContent = current.content.length <= available
      ? current.content
      : `${current.content.slice(0, Math.max(0, available - "\n[SECTION_TRUNCATED_FOR_TOKEN_BUDGET]".length))}\n[SECTION_TRUNCATED_FOR_TOKEN_BUDGET]`;
    selected.push(`${separator}${selectedContent}`);
    remaining -= separator.length + selectedContent.length;
    auditSections.push({
      title: current.title,
      originalCharacters: current.content.length,
      selectedCharacters: selectedContent.length,
      truncated: selectedContent.length < current.content.length
    });
  }

  const content = selected.join("");
  return {
    content,
    audit: {
      maxContextCharacters: maxCharacters,
      originalCharacters: value.length,
      selectedCharacters: content.length,
      estimatedInputTokens: Math.ceil(content.length / 4),
      sections: auditSections
    }
  };
}

function splitSections(value: string): Array<{ title: string; content: string }> {
  return value
    .split(/\n\n(?=## )/g)
    .filter(Boolean)
    .map((content) => ({
      title: content.match(/^##\s+(.+)$/m)?.[1] ?? "Unknown",
      content
    }));
}
