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
      const exact = bffEndpoints.find((endpoint) => normalizeMethod(endpoint.httpMethod) === method && normalizeHttpPath(endpoint.path) === path);
      const suffix = exact ?? bffEndpoints.find((endpoint) => normalizeMethod(endpoint.httpMethod) === method && pathSuffixMatches(endpoint.path, path));

      if (exact) {
        return this.createMatch(call, exact, "high", "HTTP method and normalized path exact match");
      }
      if (suffix) {
        return this.createMatch(call, suffix, "medium", "HTTP method and normalized path suffix/prefix match");
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

  private createMatch(call: UiApiCallForTrace, endpoint: SpringEndpointForTrace, confidence: "high" | "medium", reason: string): UiToBffMatch {
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
