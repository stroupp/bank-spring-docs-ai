import { ReactApiCallRecord } from "./reactApiCallExtractor";
import { ReactComponentRecord } from "./reactComponentExtractor";
import { ReactFormFieldRecord } from "./reactFormFieldExtractor";
import { ReactInteractionRecord } from "./reactInteractionExtractor";
import { ReactRouteRecord } from "./reactRouteExtractor";
import { ReactScannedFile } from "./reactRepositoryScanner";
import { ReactStateRecord } from "./reactStateExtractor";

export interface ReactRepoMapInput {
  repositoryName: string;
  branch: string;
  indicators: string[];
  files: ReactScannedFile[];
  routes: ReactRouteRecord[];
  components: ReactComponentRecord[];
  interactions: ReactInteractionRecord[];
  apiCalls: ReactApiCallRecord[];
  formFields: ReactFormFieldRecord[];
  states: ReactStateRecord[];
}

export class ReactRepoMapBuilder {
  build(input: ReactRepoMapInput): string {
    const pages = input.components.filter((component) => component.classification === "page");
    const components = input.components.filter((component) => component.classification === "component");

    return [
      "# React UI Repository Map",
      "",
      `Repository: ${input.repositoryName}`,
      `Branch: ${input.branch}`,
      "",
      "## React Project Indicators",
      ...asBullets(input.indicators),
      "",
      "## Routes",
      ...asBullets(input.routes.slice(0, 80).map((route) => `${route.route} -> ${route.pageComponent} (${route.file}) confidence=${route.confidence}`)),
      "",
      "## Pages",
      ...asBullets(pages.slice(0, 80).map((page) => `${page.component}${page.route ? ` route=${page.route}` : ""} (${page.file})`)),
      "",
      "## Main Components",
      ...asBullets(components.slice(0, 80).map((component) => `${component.component} (${component.file})`)),
      "",
      "## API Client Calls",
      ...asBullets(input.apiCalls.slice(0, 100).map((call) => `${call.httpMethod} ${call.path}${call.clientFunction ? ` via ${call.clientFunction}` : ""} (${call.file})`)),
      "",
      "## Critical Interactions",
      ...asBullets(input.interactions.slice(0, 100).map((interaction) => `${interaction.page ?? interaction.component}: ${interaction.elementType} ${interaction.event} -> ${interaction.handler} label=${interaction.label} (${interaction.file})`)),
      "",
      "## Forms and Fields",
      ...asBullets(input.formFields.slice(0, 100).map((field) => `${field.page ?? "unknown page"}: ${field.fieldName} via ${field.component} (${field.file})`)),
      "",
      "## State Usage",
      ...asBullets(input.states.slice(0, 100).map((state) => `${state.component}: ${state.stateName}/${state.setter} initial=${state.initialValue} (${state.file})`)),
      "",
      "## Index Notes",
      "This map is generated from local regex-based React static analysis and is intentionally compact for later cross-layer matching."
    ].join("\n");
  }
}

function asBullets(values: string[]): string[] {
  return values.length ? values.map((value) => `- ${value}`) : ["- Not detected"];
}
