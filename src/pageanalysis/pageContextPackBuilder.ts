import * as fs from "fs/promises";
import * as path from "path";
import { MultiRepoManifest } from "../multirepo/multiRepoManifestService";
import { readJsonl } from "../storage/jsonlWriter";
import { safeName } from "../utils/pathUtils";
import { PageCandidate } from "./pageListService";

type JsonRecord = Record<string, unknown>;

export interface PageContextPackResult {
  pageRoot: string;
  contextPackPath: string;
  pageFlowPath: string;
  selectedPage: PageCandidate;
}

export class PageContextPackBuilder {
  async build(multiRepoRoot: string, manifest: MultiRepoManifest, selectedPage: PageCandidate): Promise<PageContextPackResult> {
    const pageRoot = path.join(multiRepoRoot, "page-analysis", "pages", safeName(selectedPage.pageName || selectedPage.route || "page"));
    await fs.mkdir(pageRoot, { recursive: true });

    const data = await this.loadRelevantData(multiRepoRoot, selectedPage);
    const sourceArtifacts = await collectSourceArtifacts(multiRepoRoot);
    const pageFlow = {
      projectName: manifest.projectName,
      branch: manifest.branch,
      generatedAt: new Date().toISOString(),
      sourceArtifacts,
      selectedPage,
      ...data
    };

    const pageFlowPath = path.join(pageRoot, "page-flow.json");
    const contextPackPath = path.join(pageRoot, "page-context-pack.md");
    await fs.writeFile(pageFlowPath, `${JSON.stringify(pageFlow, null, 2)}\n`, "utf8");
    await fs.writeFile(contextPackPath, this.toMarkdown(manifest, selectedPage, data, sourceArtifacts), "utf8");

    return {
      pageRoot,
      contextPackPath,
      pageFlowPath,
      selectedPage
    };
  }

  private async loadRelevantData(multiRepoRoot: string, selectedPage: PageCandidate): Promise<{
    routes: JsonRecord[];
    components: JsonRecord[];
    interactions: JsonRecord[];
    formFields: JsonRecord[];
    states: JsonRecord[];
    uiApiCalls: JsonRecord[];
    uiToBffMatches: JsonRecord[];
    bffToBeMatches: JsonRecord[];
    pageFlows: JsonRecord[];
    bffEndpoints: JsonRecord[];
    beEndpoints: JsonRecord[];
    bffComponents: JsonRecord[];
    beComponents: JsonRecord[];
    bffDtos: JsonRecord[];
    beDtos: JsonRecord[];
    beValidations: JsonRecord[];
    bffServiceFlows: JsonRecord[];
    beServiceFlows: JsonRecord[];
    entities: JsonRecord[];
    repositories: JsonRecord[];
    qwenSummaries: JsonRecord[];
    generatedDocReferences: string[];
  }> {
    const routes = filterByPage(await readJsonl<JsonRecord>(path.join(multiRepoRoot, "ui", "route-index.jsonl")), selectedPage);
    const components = filterByPage(await readJsonl<JsonRecord>(path.join(multiRepoRoot, "ui", "component-index.jsonl")), selectedPage);
    const interactions = filterByPage(await readJsonl<JsonRecord>(path.join(multiRepoRoot, "ui", "interaction-index.jsonl")), selectedPage);
    const formFields = filterByPage(await readJsonl<JsonRecord>(path.join(multiRepoRoot, "ui", "form-field-index.jsonl")), selectedPage);
    const states = filterByPage(await readJsonl<JsonRecord>(path.join(multiRepoRoot, "ui", "state-index.jsonl")), selectedPage);
    const allUiApiCalls = await readJsonl<JsonRecord>(path.join(multiRepoRoot, "ui", "api-call-index.jsonl"));
    const uiApiCalls = allUiApiCalls.filter((record) => recordMatchesPage(record, selectedPage) || components.some((component) => sameFile(record.file, component.file)));
    const pageFlows = filterByPage(await readJsonl<JsonRecord>(path.join(multiRepoRoot, "traceability", "page-flows.jsonl")), selectedPage);
    const uiApiCallKeys = new Set([...uiApiCalls.map(formatUiApiCall), ...pageFlows.map((flow) => String(flow.uiApiCall ?? ""))].filter(Boolean));

    const uiToBffMatches = (await readJsonl<JsonRecord>(path.join(multiRepoRoot, "traceability", "ui-to-bff.jsonl")))
      .filter((match) => uiApiCallKeys.has(String(match.uiApiCall ?? "")) || recordMatchesPage(match, selectedPage));
    const bffEndpointKeys = new Set([
      ...uiToBffMatches.map((match) => String(match.bffEndpoint ?? "")),
      ...pageFlows.map((flow) => String(flow.bffEndpoint ?? ""))
    ].filter(Boolean));

    const bffToBeMatches = (await readJsonl<JsonRecord>(path.join(multiRepoRoot, "traceability", "bff-to-be.jsonl")))
      .filter((match) => bffEndpointKeys.has(String(match.bffEndpoint ?? "")) || bffEndpointKeys.has(String(match.bffOutboundCall ?? "")));
    const beEndpointKeys = new Set([
      ...bffToBeMatches.map((match) => String(match.beEndpoint ?? "")),
      ...pageFlows.map((flow) => String(flow.beEndpoint ?? ""))
    ].filter(Boolean));

    const bffEndpoints = (await readJsonl<JsonRecord>(path.join(multiRepoRoot, "bff", "api-endpoints.jsonl")))
      .filter((endpoint) => endpointKeySetHas(bffEndpointKeys, endpoint));
    const beEndpoints = (await readJsonl<JsonRecord>(path.join(multiRepoRoot, "be", "api-endpoints.jsonl")))
      .filter((endpoint) => endpointKeySetHas(beEndpointKeys, endpoint));
    const bffServiceFlows = (await readJsonl<JsonRecord>(path.join(multiRepoRoot, "bff", "bff-flow-index.jsonl")))
      .filter((flow) => bffEndpointKeys.has(String(flow.endpoint ?? "")));
    const beServiceFlows = (await readJsonl<JsonRecord>(path.join(multiRepoRoot, "be", "service-flow-index.jsonl")))
      .filter((flow) => beEndpointKeys.has(String(flow.endpoint ?? "")));
    const bffComponentNames = new Set([
      ...bffEndpoints.map((endpoint) => String(endpoint.className ?? "")),
      ...bffServiceFlows.flatMap((flow) => [
        String(flow.controller ?? ""),
        String(flow.handler ?? ""),
        ...asStringArray(flow.candidateServices),
        ...asStringArray(flow.candidateClients)
      ])
    ].filter(Boolean).map(normalize));
    const trustedBeServiceFlows = beServiceFlows.filter((flow) => String(flow.confidence ?? "") !== "low");
    const beComponentNames = new Set([
      ...beEndpoints.map((endpoint) => String(endpoint.className ?? "")),
      ...beServiceFlows.map((flow) => String(flow.controller ?? "")),
      ...trustedBeServiceFlows.flatMap((flow) => [
        ...asStringArray(flow.candidateServices),
        ...asStringArray(flow.candidateRepositories)
      ])
    ].filter(Boolean).map(normalize));
    const bffComponents = (await readJsonl<JsonRecord>(path.join(multiRepoRoot, "bff", "spring-components.jsonl")))
      .filter((component) => bffComponentNames.has(normalize(String(component.className ?? ""))));
    const beComponents = (await readJsonl<JsonRecord>(path.join(multiRepoRoot, "be", "spring-components.jsonl")))
      .filter((component) => beComponentNames.has(normalize(String(component.className ?? ""))));
    const bffDtoNames = collectDtoTypeNames(bffEndpoints);
    const beDtoNames = collectDtoTypeNames(beEndpoints);
    const bffDtos = (await readJsonl<JsonRecord>(path.join(multiRepoRoot, "bff", "dto-index.jsonl")))
      .filter((dto) => bffDtoNames.has(normalizeTypeName(String(dto.className ?? ""))));
    const beDtos = (await readJsonl<JsonRecord>(path.join(multiRepoRoot, "be", "dto-index.jsonl")))
      .filter((dto) => beDtoNames.has(normalizeTypeName(String(dto.className ?? ""))));
    const trustedEntityNames = new Set(trustedBeServiceFlows.flatMap((flow) => asStringArray(flow.entities)).map(normalize));
    const trustedRepositoryMethods = new Set(trustedBeServiceFlows.flatMap((flow) => asStringArray(flow.repositoryMethods)).map(normalize));
    const entities = (await readJsonl<JsonRecord>(path.join(multiRepoRoot, "be", "entity-index.jsonl")))
      .filter((entity) => trustedEntityNames.has(normalize(String(entity.entity ?? ""))));
    const beValidationKeys = buildValidationKeys([...beDtos, ...entities]);
    const beValidations = (await readJsonl<JsonRecord>(path.join(multiRepoRoot, "be", "validation-index.jsonl")))
      .filter((validation) => validationMatches(beValidationKeys, validation));
    const repositories = (await readJsonl<JsonRecord>(path.join(multiRepoRoot, "be", "repository-method-index.jsonl")))
      .filter((repository) => {
        const methodKey = normalize(`${repository.repository ?? ""}.${repository.method ?? ""}`);
        const entityKey = normalize(String(repository.entity ?? ""));
        return trustedRepositoryMethods.has(methodKey) || trustedEntityNames.has(entityKey);
      });
    const qwenSummaries = filterByPage(await readJsonl<JsonRecord>(path.join(multiRepoRoot, "traceability", "semantic", "page-flow-semantics.jsonl")), selectedPage);
    const generatedDocReferences = await listGeneratedDocs(multiRepoRoot);

    return {
      routes,
      components,
      interactions,
      formFields,
      states,
      uiApiCalls,
      uiToBffMatches,
      bffToBeMatches,
      pageFlows,
      bffEndpoints,
      beEndpoints,
      bffComponents,
      beComponents,
      bffDtos,
      beDtos,
      beValidations,
      bffServiceFlows,
      beServiceFlows,
      entities,
      repositories,
      qwenSummaries,
      generatedDocReferences
    };
  }

  private toMarkdown(
    manifest: MultiRepoManifest,
    selectedPage: PageCandidate,
    data: Awaited<ReturnType<PageContextPackBuilder["loadRelevantData"]>>,
    sourceArtifacts: Record<string, string>
  ): string {
    return [
      "# Sayfa Context Paketi",
      "",
      `Proje: ${manifest.projectName}`,
      `Branch: ${manifest.branch}`,
      `Sayfa: ${selectedPage.pageName}`,
      `Route: ${selectedPage.route ?? "Not visible from provided context."}`,
      `Dosya: ${selectedPage.file ?? "Not visible from provided context."}`,
      `Olusturulma zamani: ${new Date().toISOString()}`,
      "",
      "## Artifact Metadata",
      fencedJson(sourceArtifacts),
      "",
      "## Secili Sayfa Ozeti",
      fencedJson(selectedPage),
      section("Route Kayitlari", data.routes),
      section("Component Kayitlari", data.components),
      section("Interaction Kayitlari", data.interactions),
      section("Form Field Kayitlari", data.formFields),
      section("State Kayitlari", data.states),
      section("UI API Cagrilari", data.uiApiCalls),
      section("UI -> BFF Eslesmeleri", data.uiToBffMatches),
      section("BFF -> BE Eslesmeleri", data.bffToBeMatches),
      section("Page Flow Kayitlari", data.pageFlows),
      section("Ilgili BFF Endpointleri", data.bffEndpoints),
      section("Ilgili BE Endpointleri", data.beEndpoints),
      section("Ilgili BFF Componentleri", data.bffComponents),
      section("Ilgili BE Componentleri", data.beComponents),
      section("Ilgili BFF DTO Kayitlari", data.bffDtos),
      section("Ilgili BE DTO Kayitlari", data.beDtos),
      section("Ilgili BE Validasyon Kayitlari", data.beValidations),
      section("BFF Servis Flow Kayitlari", data.bffServiceFlows),
      section("BE Servis Flow Kayitlari", data.beServiceFlows),
      section("Entity Kayitlari", data.entities),
      section("Repository Method Kayitlari", data.repositories),
      section("Qwen Sayfa Semantik Ozetleri", data.qwenSummaries),
      "## Uretilmis Dokuman Referanslari",
      ...(data.generatedDocReferences.length ? data.generatedDocReferences.map((item) => `- ${item}`) : ["- Not visible from provided context."]),
      "",
      "## Context Politikasi",
      "- Bu paket yalnizca mevcut lokal indeksler, traceability, graph/quality ozetleri ve uretilmis dokuman referanslarindan olusur.",
      "- Phase 2 kapsaminda ham kaynak kod dosyalari bu pakete eklenmez.",
      "- Kaynak kanitlari Phase 3 evidence pack icinde secili snippet olarak eklenecek."
    ].join("\n");
  }
}

async function collectSourceArtifacts(multiRepoRoot: string): Promise<Record<string, string>> {
  const relativePaths = [
    "ui/page-index.jsonl",
    "ui/route-index.jsonl",
    "ui/component-index.jsonl",
    "ui/interaction-index.jsonl",
    "ui/api-call-index.jsonl",
    "bff/api-endpoints.jsonl",
    "bff/dto-index.jsonl",
    "bff/outbound-calls.jsonl",
    "bff/bff-flow-index.jsonl",
    "be/api-endpoints.jsonl",
    "be/java-method-call-index.jsonl",
    "be/dto-index.jsonl",
    "be/service-flow-index.jsonl",
    "be/repository-method-index.jsonl",
    "be/entity-index.jsonl",
    "be/validation-index.jsonl",
    "traceability/ui-to-bff.jsonl",
    "traceability/bff-to-be.jsonl",
    "traceability/page-flows.jsonl",
    "graph/graph-summary.json",
    "quality/multi-repo-quality-report.json"
  ];
  const result: Record<string, string> = {};
  for (const relativePath of relativePaths) {
    const fullPath = path.join(multiRepoRoot, relativePath);
    try {
      const stat = await fs.stat(fullPath);
      result[relativePath] = stat.mtime.toISOString();
    } catch {
      result[relativePath] = "missing";
    }
  }
  return result;
}

function section(title: string, records: JsonRecord[]): string {
  return [
    "",
    `## ${title}`,
    records.length ? records.map((record) => JSON.stringify(record)).join("\n") : "Not visible from provided context."
  ].join("\n");
}

function fencedJson(value: unknown): string {
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

function filterByPage(records: JsonRecord[], selectedPage: PageCandidate): JsonRecord[] {
  return records.filter((record) => recordMatchesPage(record, selectedPage));
}

function recordMatchesPage(record: JsonRecord, selectedPage: PageCandidate): boolean {
  const haystack = [
    record.page,
    record.pageName,
    record.pageComponent,
    record.component,
    record.route,
    record.path,
    record.file,
    record.uiPage,
    record.usedBy
  ].flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean).map((value) => normalize(String(value)));
  const needles = [selectedPage.pageName, selectedPage.route, selectedPage.file].filter(Boolean).map((value) => normalize(String(value)));
  return haystack.some((item) => needles.some((needle) => item === needle || item.includes(needle) || needle.includes(item)));
}

function sameFile(left: unknown, right: unknown): boolean {
  return Boolean(left && right && normalize(String(left)) === normalize(String(right)));
}

function formatUiApiCall(record: JsonRecord): string {
  if (record.uiApiCall) {
    return String(record.uiApiCall);
  }
  return `${record.httpMethod ?? ""} ${record.path ?? ""}`.trim();
}

function endpointKeySetHas(keys: Set<string>, endpoint: JsonRecord): boolean {
  const key = `${endpoint.httpMethod ?? ""} ${endpoint.path ?? ""}`.trim();
  return keys.has(key) || keys.has(String(endpoint.endpoint ?? ""));
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  return value ? [String(value)] : [];
}

function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function collectDtoTypeNames(endpoints: JsonRecord[]): Set<string> {
  const names = endpoints.flatMap((endpoint) => [
    endpoint.requestBody,
    endpoint.responseType,
    ...asRecords(endpoint.parameters).map((parameter) => parameter.type)
  ]);
  return new Set(names.flatMap(extractTypeNames).map(normalizeTypeName).filter(Boolean));
}

function buildValidationKeys(records: JsonRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const record of records) {
    for (const className of [record.className, record.entity]) {
      if (className) {
        keys.add(`class:${normalizeTypeName(String(className))}`);
      }
    }
    for (const field of asStringArray(record.fields)) {
      const fieldName = field.split(":")[0]?.trim();
      if (fieldName) {
        keys.add(`field:${normalize(fieldName)}`);
      }
    }
    for (const field of asRecords(record.fields)) {
      if (field.name) {
        keys.add(`field:${normalize(String(field.name))}`);
      }
    }
  }
  return keys;
}

function validationMatches(keys: Set<string>, validation: JsonRecord): boolean {
  return (
    keys.has(`class:${normalizeTypeName(String(validation.className ?? ""))}`) ||
    keys.has(`field:${normalize(String(validation.fieldOrParameter ?? ""))}`)
  );
}

function extractTypeNames(value: unknown): string[] {
  const text = String(value ?? "");
  if (!text || /^(void|boolean|byte|short|int|long|float|double|char|String|Integer|Long|Boolean|Double|Float|BigDecimal|UUID|LocalDate|LocalDateTime|Pageable|Principal|Authentication)$/i.test(text)) {
    return [];
  }
  return [...text.matchAll(/\b[A-Z][A-Za-z0-9_]*(?:DTO|Dto|Request|Response|Command|Query|Model)?\b/g)]
    .map((match) => match[0])
    .filter((name) => !/^(ResponseEntity|List|Set|Map|Optional|Page|Mono|Flux|Collection)$/i.test(name));
}

function normalizeTypeName(value: string): string {
  return value.replace(/<.*>/g, "").replace(/\[\]$/, "").replace(/[^A-Za-z0-9_]/g, "").toLowerCase();
}

async function listGeneratedDocs(multiRepoRoot: string): Promise<string[]> {
  const roots = [
    path.join(multiRepoRoot, "generated-docs"),
    path.join(multiRepoRoot, "ui", "generated-docs"),
    path.join(multiRepoRoot, "bff", "generated-docs"),
    path.join(multiRepoRoot, "be", "generated-docs")
  ];
  const results: string[] = [];
  for (const root of roots) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          results.push(path.relative(multiRepoRoot, path.join(root, entry.name)));
        }
      }
    } catch {
      // Missing generated docs are normal for early phases.
    }
  }
  return results.sort();
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\.(tsx|ts|jsx|js)$/i, "").replace(/[^a-z0-9]/g, "");
}
