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
      for (const match of file.content.matchAll(/(?:export\s+)?const\s+([A-Z][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(?:\([^)]*\)|[^=]+)=>/g)) {
        names.add(match[1]);
      }

      const childComponents = [...new Set([...file.content.matchAll(/<([A-Z][A-Za-z0-9_]*)\b/g)].map((match) => match[1]))];
      const propsType = file.content.match(/\b(?:type|interface)\s+([A-Z][A-Za-z0-9_]*(?:Props|Properties))\b/)?.[1];

      for (const component of names) {
        const route = routeByComponent.get(component);
        records.push({
          component,
          file: file.file,
          propsType,
          imports,
          exportType: /export\s+default\s+function\s+/.test(file.content) || new RegExp(`export\\s+default\\s+${component}\\b`).test(file.content) ? "default" : /export\s+(function|const)\s+/.test(file.content) ? "named" : "unknown",
          childComponents: childComponents.filter((child) => child !== component),
          classification: file.classification === "page" || Boolean(route) || /Page$/.test(component) ? "page" : "component",
          route,
          confidence: "medium"
        });
      }
    }

    return records;
  }
}
