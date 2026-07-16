import { SpringEndpointForTrace } from "./uiToBffMatcher";
import { normalizeHttpPath, normalizeMethod, pathSuffixMatches } from "./pathNormalizer";

export interface BffOutboundCallForTrace {
  client: string;
  method: string;
  sourceMethod?: string;
  httpMethod: string;
  targetPath: string;
  sourceEndpoint?: string;
  sourceController?: string;
  sourceHandler?: string;
  headers?: string[];
  bodyExpression?: string;
  file: string;
}

export interface BffToBeMatch {
  bffEndpoint: string;
  bffController: string;
  bffHandler: string;
  bffOutboundCall?: string;
  bffClient?: string;
  /** Source file that performs the BFF outbound/Feign call. */
  bffFile?: string;
  beEndpoint?: string;
  beController?: string;
  beHandler?: string;
  /** Source file that declares the matched BE endpoint. */
  beFile?: string;
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
      return {
        bffEndpoint: `${method} ${path}`,
        bffController: bff.className,
        bffHandler: bff.handlerMethod,
        confidence: "unmatched",
        matchReason: "No extracted BFF outbound call is available; public BFF endpoint paths are not used as BE target evidence"
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
      bffEndpoint: normalizeEndpointKey(call.sourceEndpoint) ?? `${method} ${path}`,
      bffController: call.sourceController ?? call.client,
      bffHandler: call.sourceHandler ?? call.sourceMethod ?? call.method,
      bffOutboundCall: `${method} ${path}`,
      bffClient: call.client,
      bffFile: call.file
    };

    if (exact) {
      const uniqueExact = exactCandidates.length === 1;
      return {
        ...base,
        beEndpoint: `${normalizeMethod(exact.httpMethod)} ${normalizeHttpPath(exact.path)}`,
        beController: exact.className,
        beHandler: exact.handlerMethod,
        ...(uniqueExact ? { beFile: exact.file } : {}),
        confidence: uniqueExact ? "high" : "low",
        matchReason: uniqueExact
          ? "BFF outbound call matched BE endpoint by HTTP method and normalized path"
          : `Ambiguous BFF outbound match: ${exactCandidates.length} BE endpoints share the normalized method/path`
      };
    }
    if (suffix) {
      const uniqueSuffix = suffixCandidates.length === 1;
      return {
        ...base,
        beEndpoint: `${normalizeMethod(suffix.httpMethod)} ${normalizeHttpPath(suffix.path)}`,
        beController: suffix.className,
        beHandler: suffix.handlerMethod,
        ...(uniqueSuffix ? { beFile: suffix.file } : {}),
        confidence: uniqueSuffix ? "medium" : "low",
        matchReason: uniqueSuffix
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

}

function normalizeEndpointKey(value: string | undefined): string | undefined {
  const match = value?.trim().match(/^([A-Za-z]+)\s+(.+)$/);
  return match ? `${normalizeMethod(match[1])} ${normalizeHttpPath(match[2])}` : undefined;
}
