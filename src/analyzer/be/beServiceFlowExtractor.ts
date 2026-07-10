import { ApiEndpoint } from "../springEndpointExtractor";
import { SpringComponent } from "../springComponentExtractor";
import { EntityIndex } from "../springEntityExtractor";
import { JavaMethodCallRecord } from "./javaMethodCallExtractor";
import { RepositoryMethodRecord } from "./repositoryMethodExtractor";

export interface BeServiceFlowRecord {
  endpoint: string;
  controller: string;
  handler: string;
  candidateServices: string[];
  candidateRepositories: string[];
  entities: string[];
  repositoryMethods: string[];
  methodCalls: string[];
  confidence: "high" | "medium" | "low";
}

export class BeServiceFlowExtractor {
  extract(
    endpoints: ApiEndpoint[],
    components: SpringComponent[],
    entities: EntityIndex[],
    repositoryMethods: RepositoryMethodRecord[],
    methodCalls: JavaMethodCallRecord[] = []
  ): BeServiceFlowRecord[] {
    const services = components.filter((component) => component.type === "service").map((component) => component.className);
    const repositories = components.filter((component) => component.type === "repository").map((component) => component.className);
    return endpoints.map((endpoint) => {
      const controllerCalls = methodCalls.filter((call) => sameName(call.className, endpoint.className) && sameName(call.methodName, endpoint.handlerMethod));
      const calledServices = unique(controllerCalls
        .map((call) => call.targetType)
        .filter((target): target is string => Boolean(target))
        .filter((target) => containsName(services, target)));
      const serviceCalls = methodCalls.filter((call) => calledServices.some((service) => sameClassName(call.className, service)));
      const calledRepositories = unique(serviceCalls
        .map((call) => call.targetType)
        .filter((target): target is string => Boolean(target))
        .filter((target) => containsName(repositories, target)));
      const matchedRepositoryMethods = repositoryMethods.filter((method) =>
        calledRepositories.some((repository) => sameClassName(repository, method.repository)) &&
        serviceCalls.some((call) => sameClassName(call.targetType ?? "", method.repository) && sameClassName(call.targetMethod, method.method))
      );
      const matchedEntities = unique(matchedRepositoryMethods.map((method) => method.entity).filter((entity): entity is string => Boolean(entity)));

      const fallbackServices = services.filter((service) => similar(endpoint.className, service) || similar(endpoint.handlerMethod, service)).slice(0, 5);
      const fallbackRepositories = repositories.filter((repository) => similar(endpoint.className, repository) || similar(endpoint.handlerMethod, repository)).slice(0, 5);
      const candidateServices = calledServices.length ? calledServices : fallbackServices;
      const candidateRepositories = calledRepositories.length ? calledRepositories : fallbackRepositories;
      const selectedRepositoryMethods = matchedRepositoryMethods.length
        ? matchedRepositoryMethods.map((method) => `${method.repository}.${method.method}`)
        : repositoryMethods
          .filter((method) => candidateRepositories.some((repository) => sameName(repository, method.repository)))
          .map((method) => `${method.repository}.${method.method}`)
          .slice(0, 20);
      const selectedEntities = matchedEntities.length
        ? matchedEntities
        : entities.filter((entity) => selectedRepositoryMethods.some((method) => normalize(method).includes(normalize(entity.entity)))).map((entity) => entity.entity).slice(0, 10);

      return {
        endpoint: `${endpoint.httpMethod} ${endpoint.path}`,
        controller: endpoint.className,
        handler: endpoint.handlerMethod,
        candidateServices,
        candidateRepositories,
        entities: selectedEntities,
        repositoryMethods: selectedRepositoryMethods,
        methodCalls: [...controllerCalls, ...serviceCalls].map((call) => `${call.className}.${call.methodName} -> ${call.targetType ?? call.targetVariable}.${call.targetMethod}`).slice(0, 40),
        confidence: calledServices.length && calledRepositories.length ? "high" : calledServices.length ? "medium" : "low"
      };
    });
  }
}

function similar(left: string, right: string): boolean {
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}

function containsName(values: string[], candidate: string): boolean {
  return values.some((value) => sameClassName(value, candidate));
}

function sameName(left: string, right: string): boolean {
  return normalize(left) === normalize(right);
}

function sameClassName(left: string, right: string): boolean {
  return normalizeClassName(left) === normalizeClassName(right);
}

function normalizeClassName(value: string): string {
  return value.toLowerCase().replace(/<.*>/g, "").replace(/[^a-z0-9]/g, "");
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/controller|service|repository|impl|api|[^a-z0-9]/g, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
