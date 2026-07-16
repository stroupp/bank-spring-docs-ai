import { ReactComponentRecord } from "./reactComponentExtractor";
import { ReactScannedFile } from "./reactRepositoryScanner";
import { findCallOpenParen, readBalancedSource, splitTopLevel } from "./reactSourceUtils";

export interface ReactApiCallRecord {
  clientFunction?: string;
  httpMethod: string;
  path: string;
  parameters: string[];
  file: string;
  usedBy: string[];
  confidence: "high" | "medium" | "low";
}

interface ConstantTable {
  local: Map<string, Map<string, string>>;
  shared: Map<string, string>;
}

interface RequestDescriptor {
  method: string;
  pathExpression: string;
  evidence: string;
  confidence: "high" | "medium";
}

const memberHttpPattern = /\b([A-Za-z_$][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\.\s*(get|post|put|patch|delete)\b/g;
const requestCallPattern = /\b((?:[A-Za-z_$][A-Za-z0-9_$]*\.)*(?:fetch|axios|request|execute|[A-Za-z_$][A-Za-z0-9_$]*(?:request|Request|execute|Execute)|sendRequest|callApi|fetchJson|(?:get|post|put|patch|delete)(?:Json|JSON|Api|Request)))\b/g;

export class ReactApiCallExtractor {
  extract(files: ReactScannedFile[], components: ReactComponentRecord[]): ReactApiCallRecord[] {
    const componentsByFile = new Map<string, ReactComponentRecord[]>();
    for (const component of components) {
      componentsByFile.set(component.file, [...(componentsByFile.get(component.file) ?? []), component]);
    }
    const pageOwnerByComponent = buildUniquePageOwners(components);
    const constants = buildConstantTable(files);
    const records: ReactApiCallRecord[] = [];

    for (const file of files) {
      const seenCallIndexes = new Set<number>();
      for (const match of file.content.matchAll(memberHttpPattern)) {
        const callIndex = match.index ?? 0;
        const openParen = findCallOpenParen(file.content, callIndex + match[0].length);
        const call = openParen === undefined ? undefined : readBalancedSource(file.content, openParen);
        if (!call) {
          continue;
        }
        const args = splitTopLevel(call.content);
        const pathExpression = args[0];
        const path = pathExpression ? resolvePathExpression(pathExpression, file.file, constants) : undefined;
        if (!path || !isLikelyHttpPath(path) || !isLikelyHttpReceiver(match[1], file, path)) {
          continue;
        }
        seenCallIndexes.add(callIndex);
        records.push(createRecord({
          descriptor: {
            method: match[2].toUpperCase(),
            pathExpression,
            evidence: call.content,
            confidence: "high"
          },
          path,
          file,
          callIndex,
          componentsByFile,
          pageOwnerByComponent,
          files,
          components
        }));
      }

      for (const match of file.content.matchAll(requestCallPattern)) {
        const callIndex = match.index ?? 0;
        if (seenCallIndexes.has(callIndex)) {
          continue;
        }
        const openParen = findCallOpenParen(file.content, callIndex + match[0].length);
        const call = openParen === undefined ? undefined : readBalancedSource(file.content, openParen);
        if (!call) {
          continue;
        }
        const descriptor = requestDescriptor(match[1], splitTopLevel(call.content), call.content);
        const path = descriptor ? resolvePathExpression(descriptor.pathExpression, file.file, constants) : undefined;
        if (!descriptor || !path || !isLikelyHttpPath(path)) {
          continue;
        }
        records.push(createRecord({
          descriptor,
          path,
          file,
          callIndex,
          componentsByFile,
          pageOwnerByComponent,
          files,
          components
        }));
      }
    }

    return dedupe(records);
  }
}

function createRecord(input: {
  descriptor: RequestDescriptor;
  path: string;
  file: ReactScannedFile;
  callIndex: number;
  componentsByFile: Map<string, ReactComponentRecord[]>;
  pageOwnerByComponent: Map<string, string>;
  files: ReactScannedFile[];
  components: ReactComponentRecord[];
}): ReactApiCallRecord {
  const functionName = functionNameNear(input.file.content, input.callIndex);
  const localOwners = input.componentsByFile.get(input.file.file)?.map((component) => component.component) ?? [];
  return {
    clientFunction: functionName,
    httpMethod: input.descriptor.method,
    path: input.path,
    parameters: extractParameterNames(input.descriptor.evidence, input.path),
    file: input.file.file,
    usedBy: localOwners.length
      ? promoteToUniquePages(localOwners, input.pageOwnerByComponent)
      : findApiConsumers(input.files, input.components, input.pageOwnerByComponent, functionName),
    confidence: input.descriptor.confidence
  };
}

function requestDescriptor(callee: string, args: string[], evidence: string): RequestDescriptor | undefined {
  const name = callee.split(".").pop() ?? callee;
  const normalized = name.toLowerCase();
  if (normalized === "fetch") {
    return args[0] ? {
      method: methodFromConfig(args[1]) ?? "GET",
      pathExpression: args[0],
      evidence,
      confidence: "high"
    } : undefined;
  }

  if (normalized === "axios" && args[0]?.trim().startsWith("{")) {
    const pathExpression = propertyExpression(args[0], ["url", "path", "endpoint", "uri"]);
    return pathExpression ? {
      method: methodFromConfig(args[0]) ?? "GET",
      pathExpression,
      evidence,
      confidence: "high"
    } : undefined;
  }

  const prefixedMethod = normalized.match(/^(get|post|put|patch|delete)(?:json|api|request)$/)?.[1]?.toUpperCase();
  if (prefixedMethod && args[0]) {
    return { method: prefixedMethod, pathExpression: args[0], evidence, confidence: "medium" };
  }

  if (!/(?:request|execute)$/.test(normalized) && !["sendrequest", "callapi", "fetchjson"].includes(normalized)) {
    return undefined;
  }
  if (args[0]?.trim().startsWith("{")) {
    const pathExpression = propertyExpression(args[0], ["url", "path", "endpoint", "uri"]);
    return pathExpression ? {
      method: methodFromConfig(args[0]) ?? "GET",
      pathExpression,
      evidence,
      confidence: "medium"
    } : undefined;
  }

  const firstLiteral = literalValue(args[0]);
  if (firstLiteral && /^(GET|POST|PUT|PATCH|DELETE)$/i.test(firstLiteral) && args[1]) {
    return {
      method: firstLiteral.toUpperCase(),
      pathExpression: args[1],
      evidence,
      confidence: "medium"
    };
  }
  return args[0] ? {
    method: methodFromConfig(args[1]) ?? (normalized === "fetchjson" ? "GET" : "GET"),
    pathExpression: args[0],
    evidence,
    confidence: "medium"
  } : undefined;
}

function methodFromConfig(config: string | undefined): string | undefined {
  if (!config) {
    return undefined;
  }
  const expression = propertyExpression(config, ["method"]);
  if (!expression) {
    return undefined;
  }
  const literal = literalValue(expression) ?? expression.match(/\.([A-Za-z]+)\s*$/)?.[1];
  return literal && /^(GET|POST|PUT|PATCH|DELETE)$/i.test(literal) ? literal.toUpperCase() : undefined;
}

function propertyExpression(objectExpression: string, keys: string[]): string | undefined {
  const trimmed = objectExpression.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  const object = readBalancedSource(trimmed, 0, "{", "}");
  if (!object) {
    return undefined;
  }
  for (const property of splitTopLevel(object.content)) {
    const match = property.match(/^\s*(?:([A-Za-z_$][A-Za-z0-9_$]*)|["'`]([^"'`]+)["'`])\s*:\s*([\s\S]+)$/);
    const key = match?.[1] ?? match?.[2];
    if (key && keys.includes(key)) {
      return match![3].trim();
    }
  }
  return undefined;
}

function buildConstantTable(files: ReactScannedFile[]): ConstantTable {
  const local = new Map<string, Map<string, string>>();
  const candidates = new Map<string, Set<string>>();
  for (const file of files) {
    const definitions = extractConstantExpressions(file.content);
    for (const [alias, original] of extractImportAliases(file.content)) {
      if (!definitions.has(alias)) {
        definitions.set(alias, original);
      }
    }
    local.set(file.file, definitions);
    for (const [name, expression] of definitions) {
      const values = candidates.get(name) ?? new Set<string>();
      values.add(expression);
      candidates.set(name, values);
    }
  }
  const shared = new Map<string, string>();
  for (const [name, values] of candidates) {
    if (values.size === 1) {
      shared.set(name, [...values][0]);
    }
  }
  return { local, shared };
}

function extractConstantExpressions(content: string): Map<string, string> {
  const definitions = new Map<string, string>();
  for (const match of content.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;]+)?=\s*/g)) {
    const start = (match.index ?? 0) + match[0].length;
    const expression = readInitializer(content, start);
    if (!expression) {
      continue;
    }
    definitions.set(match[1], expression);
    const object = expression.trim().startsWith("{") ? readBalancedSource(expression.trim(), 0, "{", "}") : undefined;
    if (object) {
      for (const property of splitTopLevel(object.content)) {
        const propertyMatch = property.match(/^\s*(?:([A-Za-z_$][A-Za-z0-9_$]*)|["'`]([^"'`]+)["'`])\s*:\s*([\s\S]+)$/);
        const key = propertyMatch?.[1] ?? propertyMatch?.[2];
        if (key) {
          definitions.set(`${match[1]}.${key}`, propertyMatch![3].trim());
        }
      }
    }
  }
  return definitions;
}

function extractImportAliases(content: string): Array<[string, string]> {
  const aliases: Array<[string, string]> = [];
  for (const match of content.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'][^"']+["']/g)) {
    for (const item of splitTopLevel(match[1])) {
      const named = item.match(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*$/);
      if (named) {
        aliases.push([named[2], named[1]]);
      }
    }
  }
  return aliases;
}

function readInitializer(content: string, start: number): string | undefined {
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") round += 1;
    else if (character === ")") round = Math.max(0, round - 1);
    else if (character === "[") square += 1;
    else if (character === "]") square = Math.max(0, square - 1);
    else if (character === "{") curly += 1;
    else if (character === "}") curly = Math.max(0, curly - 1);
    else if ((character === ";" || character === "\n") && round === 0 && square === 0 && curly === 0) {
      return content.slice(start, index).trim();
    }
  }
  return content.slice(start).trim() || undefined;
}

function resolvePathExpression(expression: string, file: string, table: ConstantTable, stack = new Set<string>()): string | undefined {
  let value = expression.trim()
    .replace(/\s+as\s+(?:const|[A-Za-z_$][A-Za-z0-9_$.<>\[\]|& ]*)\s*$/, "")
    .replace(/!\s*$/, "")
    .trim();
  if (!value) {
    return undefined;
  }

  const fallbacks = splitNullish(value);
  if (fallbacks.length > 1) {
    for (const fallback of fallbacks) {
      const resolved = resolvePathExpression(fallback, file, table, new Set(stack));
      if (resolved) {
        return resolved;
      }
    }
    return undefined;
  }

  if (value.startsWith("(") && readBalancedSource(value, 0)?.end === value.length) {
    return resolvePathExpression(value.slice(1, -1), file, table, stack);
  }
  const literal = literalValue(value);
  if (literal !== undefined) {
    return value.startsWith("`") ? resolveTemplatePath(literal, file, table, stack) : literal;
  }

  const concatenated = splitTopLevel(value, "+");
  if (concatenated.length > 1) {
    const resolvedParts = concatenated.map((part) => resolvePathExpression(part, file, table, new Set(stack)));
    return resolvedParts.every((part): part is string => part !== undefined) ? resolvedParts.join("") : undefined;
  }

  if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(value)) {
    const key = `${file}|${value}`;
    if (stack.has(key)) {
      return undefined;
    }
    stack.add(key);
    let raw = table.local.get(file)?.get(value) ?? table.shared.get(value);
    if (!raw && value.includes(".")) {
      const [root, ...members] = value.split(".");
      const alias = table.local.get(file)?.get(root);
      if (alias && /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(alias)) {
        raw = table.local.get(file)?.get(`${alias}.${members.join(".")}`) ?? table.shared.get(`${alias}.${members.join(".")}`);
      }
    }
    return raw ? resolvePathExpression(raw, file, table, stack) : undefined;
  }
  return undefined;
}

function resolveTemplatePath(template: string, file: string, table: ConstantTable, stack: Set<string>): string {
  let result = "";
  let cursor = 0;
  while (cursor < template.length) {
    const interpolation = template.indexOf("${", cursor);
    if (interpolation < 0) {
      result += template.slice(cursor);
      break;
    }
    result += template.slice(cursor, interpolation);
    const end = findTemplateInterpolationEnd(template, interpolation + 1);
    if (end === undefined) {
      result += `{${placeholderName(template.slice(interpolation + 2))}}`;
      break;
    }
    const expression = template.slice(interpolation + 2, end);
    const conditional = splitConditionalExpression(expression);
    if (conditional) {
      const whenTrue = resolvePathExpression(conditional.whenTrue, file, table, new Set(stack));
      const whenFalse = resolvePathExpression(conditional.whenFalse, file, table, new Set(stack));
      if (whenTrue !== undefined && whenFalse === "") {
        result += whenTrue;
      } else if (whenFalse !== undefined && whenTrue === "") {
        result += whenFalse;
      } else if (whenTrue !== undefined && whenTrue === whenFalse) {
        result += whenTrue;
      } else {
        result += `{${placeholderName(conditional.condition)}}`;
      }
    } else {
      result += resolvePathExpression(expression, file, table, new Set(stack)) ?? `{${placeholderName(expression)}}`;
    }
    cursor = end + 1;
  }
  return result;
}

function findTemplateInterpolationEnd(source: string, openBraceIndex: number): number | undefined {
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\"" || character === "'") {
      index = skipQuoted(source, index, character);
      continue;
    }
    if (character === "`") {
      index = skipNestedTemplate(source, index);
      continue;
    }
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function skipNestedTemplate(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
    } else if (source[index] === "`" ) {
      return index;
    } else if (source[index] === "$" && source[index + 1] === "{") {
      const end = findTemplateInterpolationEnd(source, index + 1);
      if (end === undefined) {
        return source.length - 1;
      }
      index = end;
    }
  }
  return source.length - 1;
}

function skipQuoted(source: string, start: number, quote: string): number {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
    } else if (source[index] === quote) {
      return index;
    }
  }
  return source.length - 1;
}

function splitConditionalExpression(expression: string): { condition: string; whenTrue: string; whenFalse: string } | undefined {
  let question = -1;
  let colon = -1;
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === "\"" || character === "'") {
      index = skipQuoted(expression, index, character);
      continue;
    }
    if (character === "`") {
      index = skipNestedTemplate(expression, index);
      continue;
    }
    if (character === "(") round += 1;
    else if (character === ")") round = Math.max(0, round - 1);
    else if (character === "[") square += 1;
    else if (character === "]") square = Math.max(0, square - 1);
    else if (character === "{") curly += 1;
    else if (character === "}") curly = Math.max(0, curly - 1);
    else if (character === "?" && question < 0 && round === 0 && square === 0 && curly === 0) question = index;
    else if (character === ":" && question >= 0 && round === 0 && square === 0 && curly === 0) {
      colon = index;
      break;
    }
  }
  return question >= 0 && colon > question ? {
    condition: expression.slice(0, question).trim(),
    whenTrue: expression.slice(question + 1, colon).trim(),
    whenFalse: expression.slice(colon + 1).trim()
  } : undefined;
}

function literalValue(expression: string | undefined): string | undefined {
  const value = expression?.trim();
  if (!value || !["\"", "'", "`"].includes(value[0]) || value[value.length - 1] !== value[0]) {
    return undefined;
  }
  return value.slice(1, -1);
}

function splitNullish(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < value.length - 1; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") quote = character;
    else if (character === "(") round += 1;
    else if (character === ")") round = Math.max(0, round - 1);
    else if (character === "[") square += 1;
    else if (character === "]") square = Math.max(0, square - 1);
    else if (character === "{") curly += 1;
    else if (character === "}") curly = Math.max(0, curly - 1);
    else if (character === "?" && value[index + 1] === "?" && round === 0 && square === 0 && curly === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 2;
      index += 1;
    }
  }
  if (parts.length) {
    parts.push(value.slice(start).trim());
  }
  return parts.length ? parts : [value];
}

function placeholderName(expression: string): string {
  const identifiers = [...expression.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)].map((match) => match[0]);
  return identifiers.filter((identifier) => !["encodeURIComponent", "String", "Number"].includes(identifier)).pop() ?? "param";
}

function functionNameNear(content: string, index: number): string | undefined {
  const before = content.slice(0, index);
  const ignored = new Set(["if", "for", "while", "switch", "catch"]);
  const pattern = /(?:function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(|const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>|(?:^|[,{;\n])\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>|(?:^|[,{;\n])\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{)/gm;
  let selected: string | undefined;
  for (const match of before.matchAll(pattern)) {
    const name = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (name && !ignored.has(name)) {
      selected = name;
    }
  }
  return selected;
}

function extractParameterNames(evidence: string, path: string): string[] {
  const parameters: string[] = [];
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    if (match[1] !== "param") parameters.push(match[1]);
  }
  for (const match of evidence.matchAll(/\b(?:params|query|data|body|headers)\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    parameters.push(match[1]);
  }
  for (const match of evidence.matchAll(/JSON\.stringify\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    parameters.push(match[1]);
  }
  for (const match of evidence.matchAll(/["'`]([A-Za-z][A-Za-z0-9_-]*-[A-Za-z0-9_-]+)["'`]\s*:/g)) {
    parameters.push(`header:${match[1]}`);
  }
  return [...new Set(parameters)].slice(0, 20);
}

function isLikelyHttpReceiver(receiver: string, file: ReactScannedFile, resolvedPath: string): boolean {
  const normalized = receiver.replace(/\s+/g, "").split(".").pop() ?? receiver;
  return file.classification === "api-client" || /(?:axios|api|client|http|request|gateway|service)$/i.test(normalized) || /^\/?api\//i.test(resolvedPath);
}

function isLikelyHttpPath(path: string): boolean {
  return /^(?:https?:\/\/|\/)/i.test(path) && !/^\/\/?$/.test(path);
}

function findApiConsumers(
  files: ReactScannedFile[],
  components: ReactComponentRecord[],
  pageOwnerByComponent: Map<string, string>,
  functionName?: string
): string[] {
  if (!functionName) {
    return [];
  }
  const componentByFile = new Map<string, ReactComponentRecord[]>();
  for (const component of components) {
    componentByFile.set(component.file, [...(componentByFile.get(component.file) ?? []), component]);
  }
  const consumers: string[] = [];
  for (const file of files) {
    if (!["page", "component", "hook", "store"].includes(file.classification) || !new RegExp(`(?:\\.|\\b)${escapeRegex(functionName)}\\s*\\(`).test(file.content)) {
      continue;
    }
    const owners = componentByFile.get(file.file)?.map((component) => component.component) ?? [];
    consumers.push(...(owners.length ? promoteToUniquePages(owners, pageOwnerByComponent) : [file.file]));
  }
  return [...new Set(consumers)].slice(0, 20);
}

function buildUniquePageOwners(components: ReactComponentRecord[]): Map<string, string> {
  const componentsByName = new Map<string, ReactComponentRecord[]>();
  for (const component of components) {
    componentsByName.set(component.component, [...(componentsByName.get(component.component) ?? []), component]);
  }

  const pagesByComponent = new Map<string, Set<string>>();
  for (const page of components.filter((component) => component.classification === "page")) {
    const direct = pagesByComponent.get(page.component) ?? new Set<string>();
    direct.add(page.component);
    pagesByComponent.set(page.component, direct);
    const queue = [...page.childComponents];
    const visited = new Set<string>();
    while (queue.length) {
      const name = queue.shift()!;
      if (visited.has(name)) {
        continue;
      }
      visited.add(name);
      for (const child of componentsByName.get(name) ?? []) {
        const owners = pagesByComponent.get(child.component) ?? new Set<string>();
        owners.add(page.component);
        pagesByComponent.set(child.component, owners);
        queue.push(...child.childComponents);
      }
    }
  }

  const unique = new Map<string, string>();
  for (const [component, pages] of pagesByComponent) {
    if (pages.size === 1) {
      unique.set(component, [...pages][0]);
    }
  }
  return unique;
}

function promoteToUniquePages(components: string[], pageOwnerByComponent: Map<string, string>): string[] {
  return [...new Set(components.map((component) => pageOwnerByComponent.get(component) ?? component))];
}

function dedupe(records: ReactApiCallRecord[]): ReactApiCallRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.httpMethod}|${record.path}|${record.clientFunction ?? ""}|${record.file}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
