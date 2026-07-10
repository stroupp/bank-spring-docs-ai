import { ApiEndpoint } from "./springEndpointExtractor";
import { SpringComponent } from "./springComponentExtractor";
import { EntityIndex } from "./springEntityExtractor";
import { ScannedFile } from "./repositoryScanner";

export interface RepoMapInput {
  repositoryName: string;
  branch: string;
  buildTool: string;
  files: ScannedFile[];
  components: SpringComponent[];
  endpoints: ApiEndpoint[];
  entities: EntityIndex[];
}

export class SpringRepoMapBuilder {
  build(input: RepoMapInput): string {
    const mainClass = input.components.find((component) => component.annotations.includes("SpringBootApplication"));
    const byType = (type: string) => input.components.filter((component) => component.type === type);
    const packages = [...new Set(input.components.map((component) => component.packageName).filter(Boolean))].slice(0, 25);
    const configFiles = input.files.filter((file) => file.kind === "config").map((file) => file.file);

    return [
      `# Repository Map`,
      ``,
      `Repository: ${input.repositoryName}`,
      `Branch: ${input.branch}`,
      `Build tool: ${input.buildTool}`,
      `Main application class: ${mainClass?.className ?? "Not detected"}`,
      ``,
      `## Important Packages`,
      ...asBullets(packages),
      ``,
      `## Controllers`,
      ...asBullets(byType("controller").map((component) => `${component.className} (${component.file})${component.basePath ? ` basePath=${component.basePath}` : ""}`)),
      ``,
      `## Services`,
      ...asBullets(byType("service").map((component) => `${component.className} (${component.file})`)),
      ``,
      `## Repositories`,
      ...asBullets(byType("repository").map((component) => `${component.className} (${component.file})`)),
      ``,
      `## Entities`,
      ...asBullets(input.entities.map((entity) => `${entity.entity}${entity.table ? ` table=${entity.table}` : ""} (${entity.file})`)),
      ``,
      `## API Endpoint Summary`,
      ...asBullets(input.endpoints.map((endpoint) => `${endpoint.httpMethod} ${endpoint.path} -> ${endpoint.className}.${endpoint.handlerMethod} (${endpoint.file})`)),
      ``,
      `## Configuration Files`,
      ...asBullets(configFiles),
      ``,
      `## Test Overview`,
      `Test files: ${input.files.filter((file) => file.classification === "test").length}`,
      ``,
      `## Index Notes`,
      `This map is generated from local regex-based static analysis and is intentionally compact for Copilot context.`
    ].join("\n");
  }
}

function asBullets(values: string[]): string[] {
  return values.length ? values.map((value) => `- ${value}`) : ["- Not detected"];
}
