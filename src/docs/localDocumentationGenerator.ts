import * as fs from "fs/promises";
import * as path from "path";
import { readJsonl } from "../storage/jsonlWriter";
import { Manifest } from "../storage/manifestService";
import { MarkdownWriter } from "./markdownWriter";

type FileIndex = {
  file: string;
  kind: string;
  classification?: string;
  extension: string;
  size: number;
};

type ComponentIndex = {
  type: string;
  className: string;
  packageName: string;
  file: string;
  annotations?: string[];
  stereotype?: string;
  basePath?: string;
  constructorDependencies?: string[];
  fieldInjectedDependencies?: string[];
};

type EndpointIndex = {
  httpMethod: string;
  path: string;
  className: string;
  handlerMethod: string;
  requestBody?: string;
  responseType?: string;
  pathVariables?: string[];
  requestParams?: string[];
  parameters?: Array<{
    name: string;
    type: string;
    source: string;
    required?: boolean;
    defaultValue?: string;
    raw?: string;
  }>;
  file: string;
};

type EntityIndex = {
  entity: string;
  table?: string;
  idField?: string;
  fields?: Array<{ name: string; type: string; column?: string }>;
  relationships?: Array<{ field: string; type: string; targetType: string }>;
  file: string;
};

type DependencyEdge = {
  from: string;
  to: string;
  relation: string;
  file: string;
};

type TestIndex = {
  className: string;
  file: string;
  frameworks?: string[];
  testMethods?: string[];
};

type ConfigurationIndex = {
  file: string;
  keys?: string[];
};

type SemanticClass = {
  name?: string;
  type?: string;
  purpose?: string;
  whyUsed?: string;
  responsibilities?: string[];
  usedBy?: string[];
  uses?: string[];
  businessMeaning?: string;
  technicalMeaning?: string;
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
  whyUsed?: string;
  requestMeaning?: string;
  responseMeaning?: string;
  downstreamFlow?: string[];
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
  whatDataOrControlFlowsThrough?: string;
  architecturalReason?: string;
  riskIfRemoved?: string;
  confidence?: string;
  uncertainties?: string[];
};

export type LocalDocumentKind =
  | "repository-overview"
  | "spring-architecture"
  | "api-endpoints"
  | "service-layer"
  | "repository-layer"
  | "entities"
  | "configuration"
  | "external-integrations"
  | "test-analysis"
  | "technical-analysis";

const documentMeta: Record<LocalDocumentKind, { fileName: string; title: string }> = {
  "repository-overview": { fileName: "repository-overview.md", title: "Repository Overview" },
  "spring-architecture": { fileName: "spring-architecture.md", title: "Spring Architecture" },
  "api-endpoints": { fileName: "api-endpoints.md", title: "API Endpoints" },
  "service-layer": { fileName: "service-layer.md", title: "Service Layer" },
  "repository-layer": { fileName: "repository-layer.md", title: "Repository Layer" },
  entities: { fileName: "database-entities.md", title: "Database Entities" },
  configuration: { fileName: "configuration.md", title: "Configuration" },
  "external-integrations": { fileName: "external-integrations.md", title: "External Integrations" },
  "test-analysis": { fileName: "test-analysis.md", title: "Test Analysis" },
  "technical-analysis": { fileName: "technical-analysis.md", title: "Technical Analysis" }
};

export class LocalDocumentationGenerator {
  constructor(private readonly markdownWriter = new MarkdownWriter()) {}

  async generate(aiDocsPath: string, kind: LocalDocumentKind): Promise<string> {
    const data = await this.load(aiDocsPath);
    const meta = documentMeta[kind];
    const body = this.bodyFor(kind, data);
    return this.markdownWriter.write(aiDocsPath, meta.fileName, meta.title, data.manifest.repositoryName, data.manifest.branch, body);
  }

  private async load(aiDocsPath: string) {
    const manifest = JSON.parse(await fs.readFile(path.join(aiDocsPath, "manifest.json"), "utf8")) as Manifest;
    const repoMap = await readOptional(path.join(aiDocsPath, "repo-map.md"));
    const files = await readJsonl<FileIndex>(path.join(aiDocsPath, "file-index.jsonl"));
    const components = await readJsonl<ComponentIndex>(path.join(aiDocsPath, "spring-components.jsonl"));
    const endpoints = await readJsonl<EndpointIndex>(path.join(aiDocsPath, "api-endpoints.jsonl"));
    const entities = await readJsonl<EntityIndex>(path.join(aiDocsPath, "entity-index.jsonl"));
    const dependencies = await readJsonl<DependencyEdge>(path.join(aiDocsPath, "dependency-graph.jsonl"));
    const configurations = await readJsonl<ConfigurationIndex>(path.join(aiDocsPath, "configuration-index.jsonl"));
    const tests = await readJsonl<TestIndex>(path.join(aiDocsPath, "test-index.jsonl"));
    const semanticClasses = await readJsonl<SemanticClass>(path.join(aiDocsPath, "enriched", "enriched-components.jsonl"));
    const semanticEndpoints = await readJsonl<SemanticEndpoint>(path.join(aiDocsPath, "enriched", "enriched-endpoints.jsonl"));
    const semanticDependencies = await readJsonl<SemanticDependency>(path.join(aiDocsPath, "enriched", "enriched-dependencies.jsonl"));
    return { manifest, repoMap, files, components, endpoints, entities, dependencies, configurations, tests, semanticClasses, semanticEndpoints, semanticDependencies };
  }

  private bodyFor(kind: LocalDocumentKind, data: Awaited<ReturnType<LocalDocumentationGenerator["load"]>>): string {
    switch (kind) {
      case "repository-overview":
        return this.repositoryOverview(data);
      case "spring-architecture":
        return this.springArchitecture(data);
      case "api-endpoints":
        return this.apiEndpoints(data);
      case "service-layer":
        return this.componentLayer("Service Layer", "service", data);
      case "repository-layer":
        return this.componentLayer("Repository Layer", "repository", data);
      case "entities":
        return this.entities(data);
      case "configuration":
        return this.configuration(data);
      case "external-integrations":
        return this.externalIntegrations(data);
      case "test-analysis":
        return this.tests(data);
      case "technical-analysis":
        return this.technicalAnalysis(data);
    }
  }

  private repositoryOverview(data: Awaited<ReturnType<LocalDocumentationGenerator["load"]>>): string {
    return [
      "## Purpose",
      "This document is generated from local static indexes. It does not include AI-inferred facts.",
      "",
      "## Repository Summary",
      `- Build tool: ${data.manifest.buildTool}`,
      `- Indexed files: ${data.files.length}`,
      `- Spring components: ${data.components.length}`,
      `- API endpoints: ${data.endpoints.length}`,
      `- Entities: ${data.entities.length}`,
      `- Tests: ${data.tests.length}`,
      "",
      "## Component Breakdown",
      ...countBy(data.components.map((component) => component.type)),
      "",
      "## Semantic Summary",
      ...semanticClassBullets(data.semanticClasses.slice(0, 25)),
      "",
      "## Source Map",
      data.repoMap || "Not available."
    ].join("\n");
  }

  private springArchitecture(data: Awaited<ReturnType<LocalDocumentationGenerator["load"]>>): string {
    return [
      "## Spring Boot Application Overview",
      ...bullets(data.components.filter((component) => component.annotations?.includes("SpringBootApplication")).map(formatComponent)),
      "",
      "## Controller Layer",
      ...bullets(data.components.filter((component) => component.type === "controller").map(formatComponent)),
      "",
      "## Service Layer",
      ...bullets(data.components.filter((component) => component.type === "service").map(formatComponent)),
      "",
      "### Service Semantics",
      ...semanticClassDetails(data.semanticClasses.filter((item) => item.type === "service")),
      "",
      "## Repository Layer",
      ...bullets(data.components.filter((component) => component.type === "repository").map(formatComponent)),
      "",
      "### Repository Semantics",
      ...semanticClassDetails(data.semanticClasses.filter((item) => item.type === "repository")),
      "",
      "## Dependency Overview",
      ...bullets(data.dependencies.slice(0, 80).map((edge) => `${edge.from} -> ${edge.to} (${edge.relation}) [${edge.file}]`)),
      "",
      "## Semantic Dependency Explanations",
      ...semanticDependencyDetails(data.semanticDependencies.slice(0, 60)),
      "",
      "## Risks And Assumptions",
      "- Analysis is regex-based and may miss complex Java constructs.",
      "- Only indexed files are represented."
    ].join("\n");
  }

  private apiEndpoints(data: Awaited<ReturnType<LocalDocumentationGenerator["load"]>>): string {
    return [
      "## Endpoint Summary",
      ...bullets(data.endpoints.map((endpoint) => `${endpoint.httpMethod} ${endpoint.path} -> ${endpoint.className}.${endpoint.handlerMethod}`)),
      "",
      "## Endpoint Details",
      ...data.endpoints.flatMap((endpoint) => [
        `### ${endpoint.httpMethod} ${endpoint.path}`,
        `- Handler: ${endpoint.className}.${endpoint.handlerMethod}`,
        `- Request body: ${endpoint.requestBody ?? "Not visible from provided context."}`,
        `- Response type: ${endpoint.responseType ?? "Not visible from provided context."}`,
        `- Path variables: ${formatNameList(endpoint.pathVariables)}`,
        `- Query params: ${formatNameList(endpoint.requestParams)}`,
        ...formatEndpointParameters(endpoint.parameters),
        `- Source: ${endpoint.file}`,
        ...semanticEndpointDetails(data.semanticEndpoints.find((semantic) => semantic.controller === endpoint.className && semantic.handler === endpoint.handlerMethod) ?? data.semanticEndpoints.find((semantic) => semantic.path === endpoint.path && semantic.httpMethod === endpoint.httpMethod)),
        ""
      ])
    ].join("\n");
  }

  private componentLayer(title: string, type: string, data: Awaited<ReturnType<LocalDocumentationGenerator["load"]>>): string {
    const components = data.components.filter((component) => component.type === type);
    return [
      `## ${title} Components`,
      ...bullets(components.map(formatComponent)),
      "",
      "## Semantic Meaning",
      ...semanticClassDetails(components.map((component) => data.semanticClasses.find((semantic) => semantic.name === component.className)).filter((semantic): semantic is SemanticClass => Boolean(semantic))),
      "",
      "## Dependencies",
      ...bullets(components.flatMap((component) => data.dependencies.filter((edge) => edge.from === component.className).map((edge) => `${edge.from} -> ${edge.to} (${edge.relation})`))),
      "",
      "## Semantic Dependency Explanations",
      ...semanticDependencyDetails(data.semanticDependencies.filter((dependency) => components.some((component) => component.className === dependency.from)).slice(0, 80))
    ].join("\n");
  }

  private entities(data: Awaited<ReturnType<LocalDocumentationGenerator["load"]>>): string {
    return data.entities.length
      ? data.entities.flatMap((entity) => [
          `## ${entity.entity}`,
          `- Table: ${entity.table ?? "Not visible from provided context."}`,
          `- ID field: ${entity.idField ?? "Not visible from provided context."}`,
          `- Source: ${entity.file}`,
          "",
          "### Fields",
          ...bullets((entity.fields ?? []).map((field) => `${field.name}: ${field.type}${field.column ? ` column=${field.column}` : ""}`)),
          "",
          "### Relationships",
          ...bullets((entity.relationships ?? []).map((relationship) => `${relationship.type} ${relationship.field}: ${relationship.targetType}`)),
          ""
        ]).join("\n")
      : "No JPA entities were detected.";
  }

  private configuration(data: Awaited<ReturnType<LocalDocumentationGenerator["load"]>>): string {
    return [
      "## Configuration Files",
      ...data.configurations.flatMap((configuration) => [
        `### ${configuration.file}`,
        ...bullets(configuration.keys ?? []),
        ""
      ]),
      "## Security Note",
      "Sensitive-looking configuration keys are masked during extraction when detected."
    ].join("\n");
  }

  private externalIntegrations(data: Awaited<ReturnType<LocalDocumentationGenerator["load"]>>): string {
    const clients = data.components.filter((component) => component.type === "client");
    const relevantConfig = data.configurations.flatMap((configuration) =>
      (configuration.keys ?? [])
        .filter((key) => /(url|uri|host|kafka|rabbit|mq|client|integration|external)/i.test(key))
        .map((key) => `${key} [${configuration.file}]`)
    );
    return [
      "## Client Components",
      ...bullets(clients.map(formatComponent)),
      "",
      "## Integration Configuration Signals",
      ...bullets(relevantConfig),
      "",
      "## Assumptions",
      "- External integrations are inferred from client components and configuration key names only."
    ].join("\n");
  }

  private tests(data: Awaited<ReturnType<LocalDocumentationGenerator["load"]>>): string {
    return data.tests.length
      ? data.tests.flatMap((test) => [
          `## ${test.className || test.file}`,
          `- Source: ${test.file}`,
          `- Frameworks: ${(test.frameworks ?? []).join(", ") || "Not visible from provided context."}`,
          "",
          "### Test Methods",
          ...bullets(test.testMethods ?? []),
          ""
        ]).join("\n")
      : "No test files were detected.";
  }

  private technicalAnalysis(data: Awaited<ReturnType<LocalDocumentationGenerator["load"]>>): string {
    return [
      "## Static Analysis Coverage",
      `- Indexed files: ${data.files.length}`,
      `- Java files: ${data.files.filter((file) => file.kind === "java").length}`,
      `- Build/config files: ${data.files.filter((file) => file.kind !== "java").length}`,
      "",
      "## Classification Summary",
      ...countBy(data.files.map((file) => file.classification ?? file.kind)),
      "",
      "## Semantic Enrichment Coverage",
      `- Semantic class explanations: ${data.semanticClasses.length}`,
      `- Semantic endpoint explanations: ${data.semanticEndpoints.length}`,
      `- Semantic dependency explanations: ${data.semanticDependencies.length}`,
      "",
      "## Risks",
      "- Regex extraction can miss nested annotations, generated code, Lombok-heavy patterns, and complex generics.",
      "- Dependency edges include imports and may overstate runtime dependencies.",
      "",
      "## Recommended Next Steps",
      "- Review repo-map.md for correctness.",
      "- Add Tree-sitter parsing for more precise Java extraction.",
      "- Add Copilot-generated narrative after context filtering."
    ].join("\n");
  }
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function bullets(values: string[]): string[] {
  return values.length ? values.map((value) => `- ${value}`) : ["- Not visible from provided context."];
}

function countBy(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return bullets([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${key}: ${count}`));
}

function formatComponent(component: ComponentIndex): string {
  const path = component.basePath ? ` basePath=${component.basePath}` : "";
  const stereotype = component.stereotype ? ` @${component.stereotype}` : "";
  return `${component.className}${stereotype}${path} [${component.file}]`;
}

function semanticClassBullets(items: SemanticClass[]): string[] {
  return bullets(items.map((item) => `${item.name ?? "Unknown"} (${item.type ?? "unknown"}): ${item.purpose ?? "Not visible from provided context."} Confidence=${item.confidence ?? "low"}`));
}

function semanticClassDetails(items: SemanticClass[]): string[] {
  if (!items.length) {
    return ["- Qwen semantic output not available. Run Qwen semantic analysis and enriched repo map generation first."];
  }
  return items.flatMap((item) => [
    `### ${item.name ?? "Unknown"}`,
    `- Type: ${item.type ?? "unknown"}`,
    `- Purpose: ${item.purpose ?? "Not visible from provided context."}`,
    `- Why used: ${item.whyUsed ?? "Not visible from provided context."}`,
    `- Responsibilities: ${(item.responsibilities ?? []).join(", ") || "Not visible from provided context."}`,
    `- Uses: ${(item.uses ?? []).join(", ") || "Not visible from provided context."}`,
    `- Used by: ${(item.usedBy ?? []).join(", ") || "Not visible from provided context."}`,
    `- Business meaning: ${item.businessMeaning ?? "Not visible from provided context."}`,
    `- Technical meaning: ${item.technicalMeaning ?? "Not visible from provided context."}`,
    `- Risk if changed: ${item.riskIfChanged ?? "Not visible from provided context."}`,
    `- Confidence: ${item.confidence ?? "low"}`,
    `- Uncertainties: ${(item.uncertainties ?? []).join(", ") || "None"}`,
    ""
  ]);
}

function semanticEndpointDetails(item: SemanticEndpoint | undefined): string[] {
  if (!item) {
    return [
      `- Semantic purpose: Qwen semantic output not available.`,
      `- Request meaning: Not visible from provided context.`,
      `- Response meaning: Not visible from provided context.`
    ];
  }
  return [
    `- Semantic purpose: ${item.purpose ?? "Not visible from provided context."}`,
    `- Why used: ${item.whyUsed ?? "Not visible from provided context."}`,
    `- Request meaning: ${item.requestMeaning ?? "Not visible from provided context."}`,
    `- Response meaning: ${item.responseMeaning ?? "Not visible from provided context."}`,
    `- Downstream flow: ${(item.downstreamFlow ?? []).join(" -> ") || "Not visible from provided context."}`,
    `- Business use case: ${item.businessUseCase ?? "Not visible from provided context."}`,
    `- Risk if changed: ${item.riskIfChanged ?? "Not visible from provided context."}`,
    `- Confidence: ${item.confidence ?? "low"}`,
    `- Uncertainties: ${(item.uncertainties ?? []).join(", ") || "None"}`
  ];
}

function semanticDependencyDetails(items: SemanticDependency[]): string[] {
  if (!items.length) {
    return ["- Qwen semantic dependency output not available."];
  }
  return items.map((item) =>
    `- ${item.from ?? "?"} -> ${item.to ?? "?"} (${item.relationType ?? "unknown"}): ${item.whyDependencyExists ?? "Not visible from provided context."} Flow: ${item.whatDataOrControlFlowsThrough ?? "Not visible from provided context."} Risk: ${item.riskIfRemoved ?? "Not visible from provided context."} Confidence=${item.confidence ?? "low"}`
  );
}

function formatNameList(values: string[] | undefined): string {
  return values?.length ? values.join(", ") : "None detected";
}

function formatEndpointParameters(parameters: EndpointIndex["parameters"]): string[] {
  if (!parameters?.length) {
    return ["- Parameters: None detected"];
  }
  return [
    "- Parameters:",
    ...parameters.map((parameter) => {
      const flags = [
        parameter.required === undefined ? "" : `required=${parameter.required}`,
        parameter.defaultValue ? `default=${parameter.defaultValue}` : ""
      ].filter(Boolean);
      return `  - ${parameter.source} ${parameter.name}: ${parameter.type}${flags.length ? ` (${flags.join(", ")})` : ""}`;
    })
  ];
}
