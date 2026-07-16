export type ReactFileClassification =
  | "page"
  | "component"
  | "api-client"
  | "hook"
  | "store"
  | "route"
  | "model/type"
  | "util"
  | "config"
  | "test"
  | "unknown";

export function classifyReactFile(filePath: string, content: string): ReactFileClassification {
  const normalized = filePath.toLowerCase();
  const name = normalized.split("/").pop() ?? normalized;

  if (name === "package.json" || name.includes("vite.config") || name.includes("webpack.config") || name.includes("next.config")) {
    return "config";
  }
  if (/\.(test|spec)\.(tsx|ts|jsx|js)$/.test(normalized) || normalized.includes("__tests__")) {
    return "test";
  }
  // Explicit page conventions are stronger ownership evidence than an inline
  // fetch/axios call. Pages often load their own data and must remain indexable
  // as pages for route, form, state, and API-consumer attribution.
  if (normalized.includes("/pages/") || normalized.includes("/views/") || /Page\.(tsx|jsx|ts|js)$/.test(filePath)) {
    return "page";
  }
  if (normalized.includes("/api/") || normalized.includes("api-client") || /axios|fetch\(|createApi|baseQuery/i.test(content)) {
    return "api-client";
  }
  if (normalized.includes("/routes/") || /<Route\s|createBrowserRouter|useRoutes|const\s+routes\s*=/.test(content)) {
    return "route";
  }
  if (/^use[A-Z]/.test(name.replace(/\.(tsx|ts|jsx|js)$/i, "")) || normalized.includes("/hooks/")) {
    return "hook";
  }
  if (normalized.includes("/store/") || normalized.includes("/stores/") || /createSlice|configureStore|zustand|createStore/i.test(content)) {
    return "store";
  }
  if (normalized.includes("/types/") || normalized.includes("/models/") || /\b(type|interface)\s+[A-Z]\w+/.test(content) && !/<[A-Z]\w+/.test(content)) {
    return "model/type";
  }
  if (normalized.includes("/utils/") || normalized.includes("/helpers/") || normalized.includes("/lib/")) {
    return "util";
  }
  if (/<[A-Z][A-Za-z0-9]*|\bReact\b|from\s+["']react["']/.test(content)) {
    return "component";
  }
  return "unknown";
}
