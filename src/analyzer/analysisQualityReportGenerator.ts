import * as fs from "fs/promises";
import * as path from "path";
import { readJsonl } from "../storage/jsonlWriter";
import { Manifest } from "../storage/manifestService";
import { atomicWriteFile, atomicWriteJson } from "../storage/atomicFile";

type FileIndex = { file: string; kind: string; classification?: string };
type ComponentIndex = { type: string; className: string; file: string; constructorDependencies?: string[]; fieldInjectedDependencies?: string[] };
type EndpointIndex = {
  httpMethod: string;
  path: string;
  className: string;
  handlerMethod: string;
  file: string;
  requestBody?: string;
  pathVariables?: string[];
  requestParams?: string[];
  parameters?: Array<{ name: string; type: string; source: string; raw?: string }>;
};
type EntityIndex = { entity: string; file: string };
type DependencyEdge = { from: string; to: string; relation: string; file: string };
type TestIndex = { className: string; file: string };
type ModuleMap = { modules?: Array<{ name: string; components: string[] }> };

export interface AnalysisQualityReport {
  repositoryName: string;
  branch: string;
  generatedAt: string;
  totalScannedFiles: number;
  javaFiles: number;
  configFiles: number;
  testFiles: number;
  controllersFound: number;
  servicesFound: number;
  repositoriesFound: number;
  entitiesFound: number;
  apiEndpointsFound: number;
  dependencyEdgesFound: number;
  modulesFound: number;
  unclassifiedFiles: string[];
  endpointsWithMissingOrUnclearPath: EndpointIndex[];
  endpointsWithUnparsedParameters: EndpointIndex[];
  repositoriesWithoutDetectedEntity: ComponentIndex[];
  controllersWithoutDetectedServiceDependency: ComponentIndex[];
  servicesWithoutDetectedRepositoryOrClientDependency: ComponentIndex[];
  testsThatCannotBeLinkedToComponent: TestIndex[];
  warnings: string[];
  recommendedNextActions: string[];
}

export class AnalysisQualityReportGenerator {
  async generate(aiDocsPath: string): Promise<{ markdownPath: string; jsonPath: string; report: AnalysisQualityReport }> {
    const manifest = JSON.parse(await fs.readFile(path.join(aiDocsPath, "manifest.json"), "utf8")) as Manifest;
    const files = await readJsonl<FileIndex>(path.join(aiDocsPath, "file-index.jsonl"));
    const components = await readJsonl<ComponentIndex>(path.join(aiDocsPath, "spring-components.jsonl"));
    const endpoints = await readJsonl<EndpointIndex>(path.join(aiDocsPath, "api-endpoints.jsonl"));
    const entities = await readJsonl<EntityIndex>(path.join(aiDocsPath, "entity-index.jsonl"));
    const dependencies = await readJsonl<DependencyEdge>(path.join(aiDocsPath, "dependency-graph.jsonl"));
    const tests = await readJsonl<TestIndex>(path.join(aiDocsPath, "test-index.jsonl"));
    const modules = await readJson<ModuleMap>(path.join(aiDocsPath, "module-map.json"), { modules: [] });

    const controllers = components.filter((component) => component.type === "controller");
    const services = components.filter((component) => component.type === "service");
    const repositories = components.filter((component) => component.type === "repository");
    const repositoryEntityNames = new Set(entities.map((entity) => entity.entity.replace(/Entity$/, "")));
    const componentNames = new Set(components.map((component) => component.className));

    const report: AnalysisQualityReport = {
      repositoryName: manifest.repositoryName,
      branch: manifest.branch,
      generatedAt: new Date().toISOString(),
      totalScannedFiles: files.length,
      javaFiles: files.filter((file) => file.kind === "java").length,
      configFiles: files.filter((file) => file.kind === "config").length,
      testFiles: files.filter((file) => file.classification === "test").length,
      controllersFound: controllers.length,
      servicesFound: services.length,
      repositoriesFound: repositories.length,
      entitiesFound: entities.length,
      apiEndpointsFound: endpoints.length,
      dependencyEdgesFound: dependencies.length,
      modulesFound: modules.modules?.length ?? 0,
      unclassifiedFiles: files.filter((file) => file.classification === "unknown").map((file) => file.file),
      endpointsWithMissingOrUnclearPath: endpoints.filter((endpoint) => !endpoint.path || endpoint.path === "/" || endpoint.httpMethod === "REQUEST"),
      endpointsWithUnparsedParameters: endpoints.filter((endpoint) => Boolean(endpoint.requestBody || endpoint.pathVariables?.length || endpoint.requestParams?.length) && !endpoint.parameters?.length),
      repositoriesWithoutDetectedEntity: repositories.filter((repository) => !repositoryEntityNames.has(repository.className.replace(/Repository$/, ""))),
      controllersWithoutDetectedServiceDependency: controllers.filter((controller) => !dependencies.some((edge) => edge.from === controller.className && /Service$/.test(edge.to))),
      servicesWithoutDetectedRepositoryOrClientDependency: services.filter((service) => !dependencies.some((edge) => edge.from === service.className && (/(Repository|Client)$/.test(edge.to) || /repository|client/i.test(edge.relation)))),
      testsThatCannotBeLinkedToComponent: tests.filter((test) => test.className && !componentNames.has(test.className.replace(/Test(s)?$/, ""))),
      warnings: [],
      recommendedNextActions: []
    };

    this.addWarnings(report);
    const jsonPath = path.join(aiDocsPath, "analysis-report.json");
    const markdownPath = path.join(aiDocsPath, "analysis-report.md");
    await atomicWriteJson(jsonPath, report);
    await atomicWriteFile(markdownPath, this.toMarkdown(report));
    return { markdownPath, jsonPath, report };
  }

  private addWarnings(report: AnalysisQualityReport): void {
    if (!report.controllersFound) {
      report.warnings.push("Controller bileşeni tespit edilemedi.");
    }
    if (!report.apiEndpointsFound) {
      report.warnings.push("REST API endpoint tespit edilemedi.");
    }
    if (report.unclassifiedFiles.length) {
      report.warnings.push(`${report.unclassifiedFiles.length} Java dosyası sınıflandırılamadı.`);
      report.recommendedNextActions.push("Sınıflandırılamayan dosyalar için paket/annotation/naming kontrolleri yapılmalı.");
    }
    if (report.endpointsWithMissingOrUnclearPath.length) {
      report.recommendedNextActions.push("Eksik veya belirsiz endpoint path bilgileri manuel gözden geçirilmeli.");
    }
    if (report.endpointsWithUnparsedParameters.length) {
      report.recommendedNextActions.push("Parametre detayları ayrıştırılamayan endpoint imzaları incelenmeli.");
    }
    if (report.controllersWithoutDetectedServiceDependency.length) {
      report.recommendedNextActions.push("Service bağımlılığı tespit edilmeyen controller sınıfları incelenmeli.");
    }
    if (report.servicesWithoutDetectedRepositoryOrClientDependency.length) {
      report.recommendedNextActions.push("Repository/client bağımlılığı tespit edilmeyen service sınıfları incelenmeli.");
    }
    if (!report.recommendedNextActions.length) {
      report.recommendedNextActions.push("Analiz çıktıları mimari doğrulama için ekip tarafından gözden geçirilmeli.");
    }
  }

  private toMarkdown(report: AnalysisQualityReport): string {
    return [
      "# Analiz Kalite Raporu",
      "",
      "## Özet",
      `- Repository: ${report.repositoryName}`,
      `- Branch: ${report.branch}`,
      `- Oluşturulma tarihi: ${report.generatedAt}`,
      `- Toplam taranan dosya: ${report.totalScannedFiles}`,
      `- Java dosyası: ${report.javaFiles}`,
      `- Konfigürasyon dosyası: ${report.configFiles}`,
      `- Test dosyası: ${report.testFiles}`,
      "",
      "## Tespit Edilen Bileşenler",
      `- Controller: ${report.controllersFound}`,
      `- Service: ${report.servicesFound}`,
      `- Repository: ${report.repositoriesFound}`,
      `- Entity: ${report.entitiesFound}`,
      `- Modül: ${report.modulesFound}`,
      "",
      "## API Endpoint Kalitesi",
      `- Endpoint sayısı: ${report.apiEndpointsFound}`,
      `- Eksik/belirsiz path: ${report.endpointsWithMissingOrUnclearPath.length}`,
      ...bullets(report.endpointsWithMissingOrUnclearPath.map((endpoint) => `${endpoint.httpMethod} ${endpoint.path} ${endpoint.className}.${endpoint.handlerMethod} (${endpoint.file})`)),
      `- Parametre detayı ayrıştırılamayan endpoint: ${report.endpointsWithUnparsedParameters.length}`,
      ...bullets(report.endpointsWithUnparsedParameters.map((endpoint) => `${endpoint.httpMethod} ${endpoint.path} ${endpoint.className}.${endpoint.handlerMethod} (${endpoint.file})`)),
      "",
      "## Bağımlılık Analizi Kalitesi",
      `- Dependency edge sayısı: ${report.dependencyEdgesFound}`,
      `- Service bağımlılığı tespit edilmeyen controller: ${report.controllersWithoutDetectedServiceDependency.length}`,
      `- Repository/client bağımlılığı tespit edilmeyen service: ${report.servicesWithoutDetectedRepositoryOrClientDependency.length}`,
      `- Entity ilişkisi belirsiz repository: ${report.repositoriesWithoutDetectedEntity.length}`,
      "",
      "## Sınıflandırılamayan Dosyalar",
      ...bullets(report.unclassifiedFiles),
      "",
      "## Uyarılar",
      ...bullets(report.warnings),
      "",
      "## Önerilen Aksiyonlar",
      ...bullets(report.recommendedNextActions)
    ].join("\n");
  }
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function bullets(values: string[]): string[] {
  return values.length ? values.map((value) => `- ${value}`) : ["- Yok"];
}
