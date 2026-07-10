import * as fs from "fs/promises";
import * as path from "path";
import { SpringComponent } from "./springComponentExtractor";

export interface ModuleMap {
  modules: Array<{ name: string; components: string[] }>;
}

export class SpringModuleDetector {
  build(components: SpringComponent[]): ModuleMap {
    const modules = new Map<string, string[]>();
    for (const component of components) {
      const packageParts = component.packageName.split(".");
      const moduleName = packageParts.length > 2 ? packageParts[packageParts.length - 2] : packageParts.at(-1) ?? "root";
      const existing = modules.get(moduleName) ?? [];
      existing.push(component.className);
      modules.set(moduleName, existing);
    }
    return { modules: [...modules.entries()].map(([name, values]) => ({ name, components: values })) };
  }

  async write(aiDocsPath: string, moduleMap: ModuleMap): Promise<void> {
    await fs.writeFile(path.join(aiDocsPath, "module-map.json"), JSON.stringify(moduleMap, null, 2), "utf8");
  }
}
