import * as path from "path";
import { SpringComponent } from "./springComponentExtractor";
import { atomicWriteJson } from "../storage/atomicFile";

export interface ModuleMap {
  modules: Array<{ name: string; components: string[] }>;
}

export class SpringModuleDetector {
  build(components: SpringComponent[]): ModuleMap {
    const modules = new Map<string, string[]>();
    for (const component of components) {
      const packageParts = component.packageName.split(".");
      const sourceModule = moduleFromSourcePath(component.file);
      const moduleName = sourceModule ?? (packageParts.length > 2 ? packageParts[packageParts.length - 2] : packageParts.at(-1) ?? "root");
      const existing = modules.get(moduleName) ?? [];
      existing.push(component.className);
      modules.set(moduleName, existing);
    }
    return {
      modules: [...modules.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([name, values]) => ({ name, components: [...values].sort() }))
    };
  }

  async write(aiDocsPath: string, moduleMap: ModuleMap): Promise<void> {
    await atomicWriteJson(path.join(aiDocsPath, "module-map.json"), moduleMap);
  }
}

function moduleFromSourcePath(filePath: string): string | undefined {
  const normalized = filePath.replaceAll("\\", "/");
  const marker = normalized.match(/^(.*?)\/src\/(?:main|test)\//i);
  if (!marker?.[1]) {
    return undefined;
  }
  return marker[1].split("/").filter(Boolean).join("/");
}
