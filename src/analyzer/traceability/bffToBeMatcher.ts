import { SpringEndpointForTrace } from "./uiToBffMatcher";
import { normalizeHttpPath, normalizeMethod, pathSuffixMatches } from "./pathNormalizer";

export interface BffOutboundCallForTrace {
  client: string;
  method: string;
  httpMethod: string;
  targetPath: string;
  sourceEndpoint?: string;
  file: string;
}

export interface BffToBeMatch {
  bffEndpoint: string;
  bffController: string;
  bffHandler: string;
  bffOutboundCall?: string;
  bffClient?: string;
  beEndpoint?: string;
  beController?: string;
  beHandler?: string;
  confidence: "high" | "medium" | "low" | "unmatched";
  matchReason: string;
}

export class BffToBeMatcher {
  match(
    bffEndpoints: SpringEndpointForTrace[],
    beEndpoints: SpringEndpointForTrace[],
    outboundCalls: BffOutboundCallForTrace[] = []
  ): BffToBeMatch[] {
    if (outboundCalls.length > 0) {
      return outboundCalls.map((call) => this.matchOutboundCall(call, beEndpoints));
    }

    return bffEndpoints.map((bff) => {
      const method = normalizeMethod(bff.httpMethod);
      const path = normalizeHttpPath(bff.path);
      const exactCandidates = beEndpoints.filter((endpoint) => normalizeMethod(endpoint.httpMethod) === method && normalizeHttpPath(endpoint.path) === path);
      const suffixCandidates = exactCandidates.length ? [] : beEndpoints.filter((endpoint) => normalizeMethod(endpoint.httpMethod) === method && pathSuffixMatches(endpoint.path, path));
      const exact = exactCandidates[0];
      const suffix = suffixCandidates[0];

      if (exact) {
        return this.createMatch(bff, exact, exactCandidates.length === 1 ? "high" : "low", exactCandidates.length === 1
          ? "HTTP method and normalized path exact match"
          : `Ambiguous exact match: ${exactCandidates.length} BE endpoints share the normalized method/path`);
      }
      if (suffix) {
        return this.createMatch(bff, suffix, suffixCandidates.length === 1 ? "medium" : "low", suffixCandidates.length === 1
          ? "HTTP method and normalized path suffix/prefix match"
          : `Ambiguous suffix/prefix match: ${suffixCandidates.length} BE endpoints are candidates`);
      }
      return {
        bffEndpoint: `${method} ${path}`,
        bffController: bff.className,
        bffHandler: bff.handlerMethod,
        confidence: "unmatched",
        matchReason: "No BE endpoint matched by method and normalized path"
      };
    });
  }

  private matchOutboundCall(call: BffOutboundCallForTrace, beEndpoints: SpringEndpointForTrace[]): BffToBeMatch {
    const method = normalizeMethod(call.httpMethod);
    const path = normalizeHttpPath(call.targetPath);
    const exactCandidates = beEndpoints.filter((endpoint) => normalizeMethod(endpoint.httpMethod) === method && normalizeHttpPath(endpoint.path) === path);
    const suffixCandidates = exactCandidates.length ? [] : beEndpoints.filter((endpoint) => normalizeMethod(endpoint.httpMethod) === method && pathSuffixMatches(endpoint.path, path));
    const exact = exactCandidates[0];
    const suffix = suffixCandidates[0];
    const base = {
      bffEndpoint: call.sourceEndpoint ?? `${method} ${path}`,
      bffController: call.client,
      bffHandler: call.method,
      bffOutboundCall: `${method} ${path}`,
      bffClient: call.client
    };

    if (exact) {
      return {
        ...base,
        beEndpoint: `${normalizeMethod(exact.httpMethod)} ${normalizeHttpPath(exact.path)}`,
        beController: exact.className,
        beHandler: exact.handlerMethod,
        confidence: exactCandidates.length === 1 ? "high" : "low",
        matchReason: exactCandidates.length === 1
          ? "BFF outbound call matched BE endpoint by HTTP method and normalized path"
          : `Ambiguous BFF outbound match: ${exactCandidates.length} BE endpoints share the normalized method/path`
      };
    }
    if (suffix) {
      return {
        ...base,
        beEndpoint: `${normalizeMethod(suffix.httpMethod)} ${normalizeHttpPath(suffix.path)}`,
        beController: suffix.className,
        beHandler: suffix.handlerMethod,
        confidence: suffixCandidates.length === 1 ? "medium" : "low",
        matchReason: suffixCandidates.length === 1
          ? "BFF outbound call matched BE endpoint by normalized suffix/prefix path"
          : `Ambiguous BFF outbound suffix/prefix match: ${suffixCandidates.length} BE endpoints are candidates`
      };
    }
    return {
      ...base,
      confidence: "unmatched",
      matchReason: "No BE endpoint matched BFF outbound call by method and normalized path"
    };
  }

  private createMatch(bff: SpringEndpointForTrace, be: SpringEndpointForTrace, confidence: "high" | "medium" | "low", reason: string): BffToBeMatch {
    return {
      bffEndpoint: `${normalizeMethod(bff.httpMethod)} ${normalizeHttpPath(bff.path)}`,
      bffController: bff.className,
      bffHandler: bff.handlerMethod,
      beEndpoint: `${normalizeMethod(be.httpMethod)} ${normalizeHttpPath(be.path)}`,
      beController: be.className,
      beHandler: be.handlerMethod,
      confidence,
      matchReason: reason
    };
  }
}
