import { ReactComponentRecord } from "./reactComponentExtractor";
import { ReactScannedFile } from "./reactRepositoryScanner";
import { findJsxOpeningTags, jsxAttributeExpression, literalJsxAttribute } from "./reactSourceUtils";

export interface ReactFormFieldRecord {
  page?: string;
  fieldName: string;
  component: string;
  source: string;
  file: string;
}

export class ReactFormFieldExtractor {
  extract(files: ReactScannedFile[], components: ReactComponentRecord[]): ReactFormFieldRecord[] {
    const ownerByFile = buildOwners(components);

    const records: ReactFormFieldRecord[] = [];
    for (const file of files) {
      const owner = ownerByFile.get(file.file);
      if (!owner) {
        continue;
      }
      for (const tag of findJsxOpeningTags(file.content)) {
        if (!isFieldTag(tag.name, tag.attributes)) {
          continue;
        }
        const field = fieldFromTag(tag.name, tag.attributes);
        if (!field) {
          continue;
        }
        records.push({
          page: owner.page,
          fieldName: field.fieldName,
          component: tag.name,
          source: field.source,
          file: file.file
        });
      }
    }
    return dedupe(records);
  }
}

interface FormOwner {
  component: string;
  page?: string;
}

function buildOwners(components: ReactComponentRecord[]): Map<string, FormOwner> {
  const byFile = new Map<string, ReactComponentRecord[]>();
  const byName = new Map<string, ReactComponentRecord[]>();
  for (const component of components) {
    byFile.set(component.file, [...(byFile.get(component.file) ?? []), component]);
    byName.set(component.component, [...(byName.get(component.component) ?? []), component]);
  }

  const reachablePagesByFile = new Map<string, Set<string>>();
  for (const page of components.filter((component) => component.classification === "page")) {
    const queue = [...page.childComponents];
    const visited = new Set<string>();
    while (queue.length) {
      const name = queue.shift()!;
      if (visited.has(name)) {
        continue;
      }
      visited.add(name);
      for (const child of byName.get(name) ?? []) {
        const pages = reachablePagesByFile.get(child.file) ?? new Set<string>();
        pages.add(page.component);
        reachablePagesByFile.set(child.file, pages);
        queue.push(...child.childComponents);
      }
    }
  }

  const owners = new Map<string, FormOwner>();
  for (const [file, fileComponents] of byFile) {
    const directPage = fileComponents.find((component) => component.classification === "page");
    const owner = directPage ?? fileComponents[0];
    const reachablePages = reachablePagesByFile.get(file);
    owners.set(file, {
      component: owner.component,
      page: directPage?.component ?? (reachablePages?.size === 1 ? [...reachablePages][0] : undefined)
    });
  }
  return owners;
}

function isFieldTag(name: string, attributes: string): boolean {
  const normalized = name.toLowerCase();
  if (["form", "option", "label", "button", "fieldset"].includes(normalized)) {
    return false;
  }
  return ["input", "textarea", "select"].includes(normalized) || /^[A-Z]/.test(name) || /\bregister\s*\(/.test(attributes);
}

function fieldFromTag(component: string, attributes: string): { fieldName: string; source: string } | undefined {
  const named = literalJsxAttribute(attributes, "name");
  if (named) {
    return {
      fieldName: named,
      source: component === "Controller" ? "react-hook-form Controller name" : "name attribute"
    };
  }

  const registered = attributes.match(/\bregister\s*\(\s*["'`]([^"'`]+)["'`]/)?.[1];
  if (registered) {
    return { fieldName: registered, source: "react-hook-form register binding" };
  }

  if (["input", "textarea", "select"].includes(component.toLowerCase())) {
    const controlledExpression = jsxAttributeExpression(attributes, "value") ?? jsxAttributeExpression(attributes, "checked");
    const controlled = controlledExpression ? controlledFieldName(controlledExpression) : undefined;
    if (controlled) {
      return { fieldName: controlled, source: "controlled value binding" };
    }
    const ariaLabel = controlledExpression ? safeAriaLabel(literalJsxAttribute(attributes, "aria-label")) : undefined;
    if (ariaLabel) {
      return { fieldName: ariaLabel, source: "controlled aria-label fallback" };
    }
    const id = literalJsxAttribute(attributes, "id");
    if (id && /\bonChange\s*=/.test(attributes)) {
      return { fieldName: id, source: "interactive id attribute" };
    }
  }
  return undefined;
}

function controlledFieldName(expression: string): string | undefined {
  let primary = expression.trim().split(/\?\?|\|\|/, 1)[0].trim();
  while (primary.startsWith("(") && primary.endsWith(")")) {
    primary = primary.slice(1, -1).trim();
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|\?\.)[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(primary)) {
    return undefined;
  }
  const field = primary.split(/\?\.|\./).pop();
  return field && !["value", "checked", "current"].includes(field) ? field : undefined;
}

function safeAriaLabel(value: string | undefined): string | undefined {
  const label = value?.replace(/\s+/g, " ").trim();
  return label && label.length <= 80 && /[A-Za-z0-9]/.test(label) ? label : undefined;
}

function dedupe(records: ReactFormFieldRecord[]): ReactFormFieldRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.page ?? ""}|${record.fieldName}|${record.component}|${record.file}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
