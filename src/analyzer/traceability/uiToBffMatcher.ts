import { normalizeHttpPath, normalizeMethod, pathSuffixMatches } from "./pathNormalizer";

export interface UiApiCallForTrace {
  clientFunction?: string;
  httpMethod: string;
  path: string;
  file: string;
  usedBy?: string[];
}

export interface SpringEndpointForTrace {
  httpMethod: string;
  path: string;
  className: string;
  handlerMethod: string;
  file: string;
}

export interface UiToBffMatch {
  uiPage?: string;
  uiInteraction?: string;
  uiClientFunction?: string;
  uiApiCall: string;
  uiApiFile: string;
  bffEndpoint?: string;
  bffController?: string;
  bffHandler?: string;
  bffFile?: string;
  confidence: "high" | "medium" | "low" | "unmatched";
  matchReason: string;
}

export class UiToBffMatcher {
  match(apiCalls: UiApiCallForTrace[], bffEndpoints: SpringEndpointForTrace[]): UiToBffMatch[] {
    return apiCalls.map((call) => {
      const method = normalizeMethod(call.httpMethod);
      const path = normalizeHttpPath(call.path);
      const exactCandidates = bffEndpoints.filter((endpoint) => normalizeMethod(endpoint.httpMethod) === method && normalizeHttpPath(endpoint.path) === path);
      const suffixCandidates = exactCandidates.length ? [] : bffEndpoints.filter((endpoint) => normalizeMethod(endpoint.httpMethod) === method && pathSuffixMatches(endpoint.path, path));
      const exact = exactCandidates[0];
      const suffix = suffixCandidates[0];

      if (exact) {
        return this.createMatch(call, exact, exactCandidates.length === 1 ? "high" : "low", exactCandidates.length === 1
          ? "HTTP method and normalized path exact match"
          : `Ambiguous exact match: ${exactCandidates.length} BFF endpoints share the normalized method/path`);
      }
      if (suffix) {
        return this.createMatch(call, suffix, suffixCandidates.length === 1 ? "medium" : "low", suffixCandidates.length === 1
          ? "HTTP method and normalized path suffix/prefix match"
          : `Ambiguous suffix/prefix match: ${suffixCandidates.length} BFF endpoints are candidates`);
      }

      return {
        uiPage: call.usedBy?.[0],
        uiClientFunction: call.clientFunction,
        uiApiCall: `${method} ${path}`,
        uiApiFile: call.file,
        confidence: "unmatched",
        matchReason: "No BFF endpoint matched by method and normalized path"
      };
    });
  }

  private createMatch(call: UiApiCallForTrace, endpoint: SpringEndpointForTrace, confidence: "high" | "medium" | "low", reason: string): UiToBffMatch {
    return {
      uiPage: call.usedBy?.[0],
      uiClientFunction: call.clientFunction,
      uiApiCall: `${normalizeMethod(call.httpMethod)} ${normalizeHttpPath(call.path)}`,
      uiApiFile: call.file,
      bffEndpoint: `${normalizeMethod(endpoint.httpMethod)} ${normalizeHttpPath(endpoint.path)}`,
      bffController: endpoint.className,
      bffHandler: endpoint.handlerMethod,
      bffFile: endpoint.file,
      confidence,
      matchReason: reason
    };
  }
}
