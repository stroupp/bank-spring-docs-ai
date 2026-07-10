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
  confidence: "medium" | "low";
}

export class BffFlowIndexBuilder {
  build(endpoints: ApiEndpoint[], components: SpringComponent[], outboundCalls: BffOutboundCall[]): BffFlowRecord[] {
    const services = components.filter((component) => component.type === "service").map((component) => component.className);
    const clients = outboundCalls.map((call) => call.client);
    return endpoints.map((endpoint) => {
      const endpointKey = `${endpoint.httpMethod} ${endpoint.path}`;
      const endpointCalls = outboundCalls.filter((call) => call.sourceEndpoint === endpointKey);
      const relatedCalls = endpointCalls.length > 0 ? endpointCalls : outboundCalls.filter((call) => similar(endpoint.handlerMethod, call.method));
      return {
        endpoint: endpointKey,
        controller: endpoint.className,
        handler: endpoint.handlerMethod,
        candidateServices: services.filter((service) => similar(endpoint.className, service) || similar(endpoint.handlerMethod, service)).slice(0, 5),
        candidateClients: [...new Set(clients.filter((client) => relatedCalls.some((call) => call.client === client) || similar(endpoint.handlerMethod, client) || similar(endpoint.path, client)))].slice(0, 5),
        outboundCalls: relatedCalls.map((call) => `${call.httpMethod} ${call.targetPath} via ${call.client}.${call.method}`).slice(0, 20),
        confidence: endpointCalls.length > 0 ? "medium" : "low"
      };
    });
  }
}

function similar(left: string, right: string): boolean {
  const a = left.toLowerCase().replace(/controller|service|client|bff|api|[^a-z0-9]/g, "");
  const b = right.toLowerCase().replace(/controller|service|client|bff|api|[^a-z0-9]/g, "");
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}
