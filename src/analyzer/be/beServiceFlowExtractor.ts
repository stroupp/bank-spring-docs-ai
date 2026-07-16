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
      const controllerCalls = methodCalls.filter((call) =>
        sameClassName(call.className, endpoint.className) && sameIdentifier(call.methodName, endpoint.handlerMethod));
      const serviceTraversal = collectReachableServiceCalls(methodCalls, services, controllerCalls);
      const calledServices = serviceTraversal.services;
      const serviceCalls = serviceTraversal.calls;
      const calledRepositories = unique(serviceCalls
        .map((call) => call.targetType)
        .filter((target): target is string => Boolean(target))
        .filter((target) => containsName(repositories, target)));
      const matchedRepositoryMethods = repositoryMethods.filter((method) =>
        calledRepositories.some((repository) => sameClassName(repository, method.repository)) &&
        serviceCalls.some((call) => sameClassName(call.targetType ?? "", method.repository) && sameClassName(call.targetMethod, method.method))
      );
      const matchedEntities = unique(matchedRepositoryMethods.map((method) => method.entity).filter((entity): entity is string => Boolean(entity)));
      const calledRepositoryMethods = unique(serviceCalls.flatMap((call) => {
        const repository = call.targetType && repositories.find((candidate) => sameClassName(candidate, call.targetType ?? ""));
        return repository ? [`${repository}.${call.targetMethod}`] : [];
      }));
      const repositoryEntities = unique(calledRepositories.flatMap((repository) => {
        const component = components.find((candidate) =>
          candidate.type === "repository" && sameClassName(candidate.className, repository));
        const entity = component && entityForRepository(component, entities);
        return entity ? [entity] : [];
      }));

      const fallbackServices = services.filter((service) => similar(endpoint.className, service) || similar(endpoint.handlerMethod, service)).slice(0, 5);
      const fallbackRepositories = repositories.filter((repository) => similar(endpoint.className, repository) || similar(endpoint.handlerMethod, repository)).slice(0, 5);
      const candidateServices = calledServices.length ? calledServices : fallbackServices;
      const candidateRepositories = calledRepositories.length ? calledRepositories : fallbackRepositories;
      const selectedRepositoryMethods = unique([
        ...calledRepositoryMethods,
        ...matchedRepositoryMethods.map((method) => `${method.repository}.${method.method}`)
      ]).slice(0, 20);
      const selectedEntities = unique([...matchedEntities, ...repositoryEntities]).slice(0, 10);

      return {
        endpoint: `${endpoint.httpMethod} ${endpoint.path}`,
        controller: endpoint.className,
        handler: endpoint.handlerMethod,
        candidateServices,
        candidateRepositories,
        entities: selectedEntities,
        repositoryMethods: selectedRepositoryMethods,
        methodCalls: unique([...controllerCalls, ...serviceCalls]
          .map((call) => `${call.className}.${call.methodName} -> ${call.targetType ?? call.targetVariable}.${call.targetMethod}`))
          .slice(0, 40),
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

function sameIdentifier(left: string, right: string): boolean {
  return left.toLowerCase().replace(/[^a-z0-9]/g, "") === right.toLowerCase().replace(/[^a-z0-9]/g, "");
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

function collectReachableServiceCalls(
  methodCalls: JavaMethodCallRecord[],
  serviceNames: string[],
  entryCalls: JavaMethodCallRecord[]
): { services: string[]; calls: JavaMethodCallRecord[] } {
  const queue: Array<{ className: string; methodName: string }> = [];
  const reachedServices: string[] = [];
  for (const call of entryCalls) {
    const service = call.targetType && serviceNames.find((candidate) => sameClassName(candidate, call.targetType ?? ""));
    if (service) {
      reachedServices.push(service);
      queue.push({ className: service, methodName: call.targetMethod });
    }
  }

  const calls: JavaMethodCallRecord[] = [];
  const visited = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    const key = `${normalizeClassName(current.className)}.${current.methodName.toLowerCase()}`;
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);

    const currentCalls = methodCalls.filter((call) =>
      sameClassName(call.className, current.className) && sameIdentifier(call.methodName, current.methodName));
    calls.push(...currentCalls);
    for (const call of currentCalls) {
      const downstreamService = call.targetType && serviceNames.find((candidate) => sameClassName(candidate, call.targetType ?? ""));
      if (downstreamService) {
        reachedServices.push(downstreamService);
        queue.push({ className: downstreamService, methodName: call.targetMethod });
      }
    }
  }

  return { services: unique(reachedServices), calls };
}

function entityForRepository(component: SpringComponent, entities: EntityIndex[]): string | undefined {
  const genericEntity = extractSpringDataEntity(component.extendedClass);
  if (genericEntity) {
    return entities.find((entity) => sameClassName(entity.entity, genericEntity))?.entity ?? genericEntity;
  }

  const repositoryStem = component.className.replace(/Repository$/i, "");
  return entities.find((entity) => sameClassName(entity.entity, repositoryStem))?.entity;
}

function extractSpringDataEntity(extendedClass: string | undefined): string | undefined {
  if (!extendedClass || !/^(?:JpaRepository|CrudRepository|PagingAndSortingRepository|Repository)\s*</.test(extendedClass.trim())) {
    return undefined;
  }
  const entityType = extendedClass.match(/<\s*([A-Za-z_$][A-Za-z0-9_$.]*)/)?.[1];
  return entityType?.split(".").pop();
}
