import { JavaMethodCallRecord } from "../be/javaMethodCallExtractor";
import { ApiEndpoint } from "../springEndpointExtractor";
import { SpringComponent } from "../springComponentExtractor";
import { BffOutboundCall } from "./bffOutboundCallExtractor";

export interface BffFlowRecord {
  endpoint: string;
  controller: string;
  handler: string;
  candidateServices: string[];
  candidateClients: string[];
  outboundCalls: string[];
  methodCalls: string[];
  confidence: "high" | "medium" | "low";
}

interface EndpointResolution {
  endpoint: ApiEndpoint;
  endpointKey: string;
  directCalls: BffOutboundCall[];
  graphCalls: BffOutboundCall[];
  traceCalls: JavaMethodCallRecord[];
  services: string[];
}

export class BffFlowIndexBuilder {
  build(
    endpoints: ApiEndpoint[],
    components: SpringComponent[],
    outboundCalls: BffOutboundCall[],
    methodCalls: JavaMethodCallRecord[] = []
  ): BffFlowRecord[] {
    const services = components.filter((component) => component.type === "service").map((component) => component.className);
    const resolutions = endpoints.map((endpoint) => this.resolveEndpoint(endpoint, services, outboundCalls, methodCalls));
    this.attachUniqueSourceEndpoints(resolutions);

    return resolutions.map((resolution) => {
      const { endpoint, endpointKey, directCalls, graphCalls, traceCalls } = resolution;
      const evidenceCalls = uniqueRecords([...directCalls, ...graphCalls]);
      const fallbackCalls = evidenceCalls.length
        ? []
        : outboundCalls.filter((call) =>
          similar(endpoint.handlerMethod, call.sourceMethod ?? call.method) ||
          similar(endpoint.path, call.client)
        );
      const relatedCalls = evidenceCalls.length ? evidenceCalls : fallbackCalls;
      const fallbackServices = services
        .filter((service) => similar(endpoint.className, service) || similar(endpoint.handlerMethod, service))
        .slice(0, 5);
      const candidateServices = resolution.services.length ? resolution.services : fallbackServices;

      return {
        endpoint: endpointKey,
        controller: endpoint.className,
        handler: endpoint.handlerMethod,
        candidateServices,
        candidateClients: unique(relatedCalls.map((call) => call.client)).slice(0, 5),
        outboundCalls: relatedCalls
          .map((call) => `${call.httpMethod} ${call.targetPath} via ${call.client}.${call.sourceMethod ?? call.method}`)
          .slice(0, 20),
        methodCalls: traceCalls.map(formatMethodCall).slice(0, 40),
        confidence: graphCalls.length ? "high" : directCalls.length ? "medium" : "low"
      };
    });
  }

  private resolveEndpoint(
    endpoint: ApiEndpoint,
    services: string[],
    outboundCalls: BffOutboundCall[],
    methodCalls: JavaMethodCallRecord[]
  ): EndpointResolution {
    const endpointKey = `${endpoint.httpMethod} ${endpoint.path}`;
    const directCalls = outboundCalls.filter((call) => call.sourceEndpoint === endpointKey);
    const controllerCalls = methodCalls.filter((call) =>
      sameClassName(call.className, endpoint.className) && sameMethodName(call.methodName, endpoint.handlerMethod)
    );
    const queue = [...controllerCalls];
    const traceCalls: JavaMethodCallRecord[] = [];
    const graphCalls: BffOutboundCall[] = [];
    const calledServices: string[] = [];
    const visited = new Set<string>();

    while (queue.length) {
      const call = queue.shift()!;
      const key = `${call.className}|${call.methodName}|${call.targetType ?? call.targetVariable}|${call.targetMethod}`;
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      traceCalls.push(call);

      const matchingOutbound = outboundCalls.filter((outbound) => invocationMatchesOutbound(call, outbound));
      graphCalls.push(...matchingOutbound);

      const target = call.targetType ?? call.targetVariable;
      const service = services.find((candidate) => sameClassName(candidate, target));
      if (!service) {
        continue;
      }
      calledServices.push(service);
      queue.push(...methodCalls.filter((candidate) =>
        sameClassName(candidate.className, service) && sameMethodName(candidate.methodName, call.targetMethod)
      ));
    }

    return {
      endpoint,
      endpointKey,
      directCalls: uniqueRecords(directCalls),
      graphCalls: uniqueRecords(graphCalls),
      traceCalls,
      services: unique(calledServices)
    };
  }

  private attachUniqueSourceEndpoints(resolutions: EndpointResolution[]): void {
    const associations = new Map<BffOutboundCall, EndpointResolution[]>();
    for (const resolution of resolutions) {
      for (const call of uniqueRecords([...resolution.directCalls, ...resolution.graphCalls])) {
        const existing = associations.get(call) ?? [];
        existing.push(resolution);
        associations.set(call, existing);
      }
    }

    for (const [call, candidates] of associations) {
      const uniqueCandidates = candidates.filter((candidate, index, all) =>
        all.findIndex((other) => other.endpointKey === candidate.endpointKey && other.endpoint.className === candidate.endpoint.className) === index
      );
      if (uniqueCandidates.length !== 1) {
        continue;
      }
      const source = uniqueCandidates[0];
      call.sourceEndpoint = source.endpointKey;
      call.sourceController = source.endpoint.className;
      call.sourceHandler = source.endpoint.handlerMethod;
    }
  }
}

function invocationMatchesOutbound(call: JavaMethodCallRecord, outbound: BffOutboundCall): boolean {
  const target = call.targetType ?? call.targetVariable;
  return sameClassName(target, outbound.client) && sameMethodName(call.targetMethod, outbound.sourceMethod ?? outbound.method);
}

function formatMethodCall(call: JavaMethodCallRecord): string {
  return `${call.className}.${call.methodName} -> ${call.targetType ?? call.targetVariable}.${call.targetMethod}`;
}

function similar(left: string, right: string): boolean {
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}

function sameMethodName(left: string, right: string): boolean {
  return normalizeName(left) === normalizeName(right);
}

function sameClassName(left: string, right: string): boolean {
  return normalizeClassName(left) === normalizeClassName(right);
}

function normalizeClassName(value: string): string {
  return normalizeName(value)
    .replace(/implementation$/, "")
    .replace(/impl$/, "")
    .replace(/restclient$/, "client")
    .replace(/httpclient$/, "client");
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/<.*>/g, "").replace(/[^a-z0-9]/g, "");
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/controller|service|client|bff|api|impl|[^a-z0-9]/g, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueRecords<T extends object>(values: T[]): T[] {
  return [...new Set(values)];
}
