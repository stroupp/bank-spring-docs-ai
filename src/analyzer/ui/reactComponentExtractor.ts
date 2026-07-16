import { ReactRouteRecord } from "./reactRouteExtractor";
import { ReactScannedFile } from "./reactRepositoryScanner";

export interface ReactComponentRecord {
  component: string;
  file: string;
  propsType?: string;
  imports: string[];
  exportType: "default" | "named" | "unknown";
  childComponents: string[];
  classification: "page" | "component";
  route?: string;
  confidence: "high" | "medium" | "low";
}

export class ReactComponentExtractor {
  extract(files: ReactScannedFile[], routes: ReactRouteRecord[]): ReactComponentRecord[] {
    const routeByComponent = new Map(routes.map((route) => [route.pageComponent, route.route]));
    const records: ReactComponentRecord[] = [];

    for (const file of files) {
      if (!["page", "component", "route"].includes(file.classification)) {
        continue;
      }

      const imports = [...file.content.matchAll(/import\s+(?:[^"']+)\s+from\s+["']([^"']+)["']/g)].map((match) => match[1]);
      const names = new Set<string>();
      for (const match of file.content.matchAll(/(?:export\s+default\s+function|export\s+function|function)\s+([A-Z][A-Za-z0-9_]*)\s*\(/g)) {
        names.add(match[1]);
      }
      for (const match of file.content.matchAll(/(?:export\s+)?const\s+([A-Z][A-Za-z0-9_]*)\s*(?::[^=;]+)?=\s*/g)) {
        if (looksLikeComponentInitializer(file.content.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 800))) {
          names.add(match[1]);
        }
      }
      if (/export\s+default\s+(?:(?:React\.)?(?:memo|forwardRef)\s*\(\s*)?(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/.test(file.content)) {
        const inferred = file.file.split("/").pop()?.replace(/\.(?:tsx|ts|jsx|js)$/i, "");
        if (inferred && /^[A-Z][A-Za-z0-9_]*$/.test(inferred)) {
          names.add(inferred);
        }
      }

      const childComponents = [...new Set([...file.content.matchAll(/<([A-Z][A-Za-z0-9_]*)\b/g)].map((match) => match[1]))];
      const propsType = file.content.match(/\b(?:type|interface)\s+([A-Z][A-Za-z0-9_]*(?:Props|Properties))\b/)?.[1];
      const fileBaseName = file.file.split("/").pop()?.replace(/\.(?:tsx|ts|jsx|js)$/i, "");

      for (const component of names) {
        const route = routeByComponent.get(component);
        const isPrimaryPage = file.classification === "page" && (
          component === fileBaseName || /Page$/.test(component) || names.size === 1
        );
        records.push({
          component,
          file: file.file,
          propsType,
          imports,
          exportType: isDefaultExport(file.content, component) ? "default" : isNamedExport(file.content, component) ? "named" : "unknown",
          childComponents: childComponents.filter((child) => child !== component),
          classification: isPrimaryPage || Boolean(route) ? "page" : "component",
          route,
          confidence: route ? "high" : "medium"
        });
      }
    }

    return records;
  }
}

function looksLikeComponentInitializer(source: string): boolean {
  const trimmed = source.trimStart();
  if (/^(?:(?:React\.)?(?:memo|forwardRef)\s*\(\s*)?(?:async\s*)?(?:<[^;=]+>\s*)?(?:\([^;=]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/.test(trimmed)) {
    return true;
  }
  return /^(?:React\.)?(?:memo|forwardRef)\s*\(\s*(?:function\b|(?:async\s*)?\([^;=]*\)\s*=>)/.test(trimmed);
}

function isDefaultExport(source: string, component: string): boolean {
  return new RegExp(`export\\s+default\\s+(?:function\\s+)?${escapeRegex(component)}\\b`).test(source) ||
    (new RegExp(`(?:const|function)\\s+${escapeRegex(component)}\\b`).test(source) && new RegExp(`export\\s+default\\s+${escapeRegex(component)}\\b`).test(source)) ||
    (/export\s+default\s+(?:(?:React\.)?(?:memo|forwardRef)\s*\(\s*)?(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/.test(source) &&
      source.includes(component));
}

function isNamedExport(source: string, component: string): boolean {
  return new RegExp(`export\\s+(?:function|const)\\s+${escapeRegex(component)}\\b`).test(source) ||
    new RegExp(`export\\s*\\{[^}]*\\b${escapeRegex(component)}\\b[^}]*\\}`).test(source);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
