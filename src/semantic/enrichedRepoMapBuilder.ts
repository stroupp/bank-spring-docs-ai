import * as fs from "fs/promises";
import * as path from "path";
import { readJsonl } from "../storage/jsonlWriter";
import { Manifest } from "../storage/manifestService";

type SemanticClass = {
  name?: string;
  type?: string;
  purpose?: string;
  whyUsed?: string;
  responsibilities?: string[];
  usedBy?: string[];
  uses?: string[];
  riskIfChanged?: string;
  confidence?: string;
  uncertainties?: string[];
};

type SemanticEndpoint = {
  endpoint?: string;
  httpMethod?: string;
  path?: string;
  controller?: string;
  handler?: string;
  purpose?: string;
  businessUseCase?: string;
  riskIfChanged?: string;
  confidence?: string;
  uncertainties?: string[];
};

type SemanticDependency = {
  from?: string;
  to?: string;
  relationType?: string;
  whyDependencyExists?: string;
  architecturalReason?: string;
  riskIfRemoved?: string;
  confidence?: string;
  uncertainties?: string[];
};

export class EnrichedRepoMapBuilder {
  async build(aiDocsPath: string): Promise<string> {
    const manifest = JSON.parse(await fs.readFile(path.join(aiDocsPath, "manifest.json"), "utf8")) as Manifest;
    const repoMap = await readOptional(path.join(aiDocsPath, "repo-map.md"));
    const classes = await readJsonl<SemanticClass>(path.join(aiDocsPath, "enriched", "enriched-components.jsonl"));
    const endpoints = await readJsonl<SemanticEndpoint>(path.join(aiDocsPath, "enriched", "enriched-endpoints.jsonl"));
    const dependencies = await readJsonl<SemanticDependency>(path.join(aiDocsPath, "enriched", "enriched-dependencies.jsonl"));

    const content = [
      "# Zenginleştirilmiş Repository Haritası",
      "",
      "## Repository Bilgisi",
      `- Repository: ${manifest.repositoryName}`,
      `- Branch: ${manifest.branch}`,
      `- Build tool: ${manifest.buildTool}`,
      `- Oluşturulma tarihi: ${new Date().toISOString()}`,
      "",
      "## Spring Boot Genel Görünüm",
      repoMap || "Normal repo map bulunamadı.",
      "",
      "## Modüller",
      "Modül bilgisi normal repo map içinde özetlenmiştir.",
      "",
      "## Controller Katmanı",
      ...classSection(classes.filter((item) => item.type === "controller")),
      "",
      "## Service Katmanı",
      ...classSection(classes.filter((item) => item.type === "service")),
      "",
      "## Repository / Persistence Katmanı",
      ...classSection(classes.filter((item) => item.type === "repository")),
      "",
      "## Entity / Veri Modeli",
      ...classSection(classes.filter((item) => item.type === "entity")),
      "",
      "## API Endpointleri",
      ...endpointSection(endpoints),
      "",
      "## Önemli Bağımlılıklar",
      ...dependencySection(dependencies.slice(0, 80)),
      "",
      "## Qwen Semantik Açıklamaları",
      `- Semantik sınıf açıklaması: ${classes.length}`,
      `- Semantik endpoint açıklaması: ${endpoints.length}`,
      `- Semantik bağımlılık açıklaması: ${dependencies.length}`,
      "",
      "## Riskler ve Belirsizlikler",
      ...riskSection(classes, endpoints, dependencies)
    ].join("\n");

    const target = path.join(aiDocsPath, "enriched", "enriched-repo-map.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    return target;
  }
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function classSection(items: SemanticClass[]): string[] {
  if (!items.length) {
    return ["- Qwen semantik çıktı bulunamadı."];
  }
  return items.flatMap((item) => [
    `### ${item.name ?? "Bilinmeyen Sınıf"}`,
    `- Tip: ${item.type ?? "unknown"}`,
    `- Amaç: ${item.purpose ?? "Not visible from provided context."}`,
    `- Neden kullanılır: ${item.whyUsed ?? "Not visible from provided context."}`,
    `- Sorumluluklar: ${(item.responsibilities ?? []).join(", ") || "Not visible from provided context."}`,
    `- Kullandıkları: ${(item.uses ?? []).join(", ") || "Not visible from provided context."}`,
    `- Kullananlar: ${(item.usedBy ?? []).join(", ") || "Not visible from provided context."}`,
    `- Değişirse risk: ${item.riskIfChanged ?? "Not visible from provided context."}`,
    `- Güven: ${item.confidence ?? "low"}`,
    `- Belirsizlikler: ${(item.uncertainties ?? []).join(", ") || "Yok"}`,
    ""
  ]);
}

function endpointSection(items: SemanticEndpoint[]): string[] {
  if (!items.length) {
    return ["- Qwen endpoint açıklaması bulunamadı."];
  }
  return items.flatMap((item) => [
    `### ${item.httpMethod ?? ""} ${item.path ?? item.endpoint ?? ""}`,
    `- Controller: ${item.controller ?? "Not visible from provided context."}`,
    `- Handler: ${item.handler ?? "Not visible from provided context."}`,
    `- Amaç: ${item.purpose ?? "Not visible from provided context."}`,
    `- İş kullanım senaryosu: ${item.businessUseCase ?? "Not visible from provided context."}`,
    `- Değişirse risk: ${item.riskIfChanged ?? "Not visible from provided context."}`,
    `- Güven: ${item.confidence ?? "low"}`,
    ""
  ]);
}

function dependencySection(items: SemanticDependency[]): string[] {
  if (!items.length) {
    return ["- Qwen bağımlılık açıklaması bulunamadı."];
  }
  return items.flatMap((item) => [
    `- ${item.from ?? "?"} -> ${item.to ?? "?"} (${item.relationType ?? "unknown"}): ${item.whyDependencyExists ?? item.architecturalReason ?? "Not visible from provided context."}`
  ]);
}

function riskSection(classes: SemanticClass[], endpoints: SemanticEndpoint[], dependencies: SemanticDependency[]): string[] {
  const risks = [
    ...classes.map((item) => item.riskIfChanged).filter(Boolean),
    ...endpoints.map((item) => item.riskIfChanged).filter(Boolean),
    ...dependencies.map((item) => item.riskIfRemoved).filter(Boolean)
  ] as string[];
  return risks.length ? risks.slice(0, 40).map((risk) => `- ${risk}`) : ["- Semantik risk bilgisi bulunamadı."];
}
