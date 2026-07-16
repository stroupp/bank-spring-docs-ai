import { ReactComponentRecord } from "./reactComponentExtractor";
import { ReactScannedFile } from "./reactRepositoryScanner";
import { findCallOpenParen, readBalancedSource, splitTopLevel } from "./reactSourceUtils";

export interface ReactStateRecord {
  component: string;
  stateName: string;
  setter: string;
  initialValue: string;
  file: string;
}

export class ReactStateExtractor {
  extract(files: ReactScannedFile[], components: ReactComponentRecord[]): ReactStateRecord[] {
    const componentByFile = new Map<string, ReactComponentRecord | undefined>();
    for (const file of files) {
      const fileComponents = components.filter((component) => component.file === file.file);
      componentByFile.set(file.file, fileComponents.find((component) => component.classification === "page") ?? fileComponents[0]);
    }

    const records: ReactStateRecord[] = [];
    for (const file of files) {
      for (const match of file.content.matchAll(/const\s*\[\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\]\s*=\s*(?:React\.)?(useState|useReducer)\b/g)) {
        const openParen = findCallOpenParen(file.content, (match.index ?? 0) + match[0].length);
        const call = openParen === undefined ? undefined : readBalancedSource(file.content, openParen);
        if (!call) {
          continue;
        }
        const args = splitTopLevel(call.content);
        const hook = match[3];
        const initialArgument = hook === "useReducer" ? args[1] : args[0];
        const owner = componentByFile.get(file.file)?.component ?? functionNameNear(file.content, match.index ?? 0) ?? fileOwner(file.file);
        if (!owner) {
          continue;
        }
        const initialValue = hook === "useReducer" && args[2]
          ? `${compact(args[2])}(${compact(initialArgument ?? "undefined")})`
          : compact(initialArgument ?? "undefined");
        records.push({
          component: owner,
          stateName: match[1],
          setter: match[2],
          initialValue,
          file: file.file
        });

        if (hook === "useReducer" && !args[2] && initialArgument) {
          for (const field of reducerInitialFields(file.content, initialArgument)) {
            records.push({
              component: owner,
              stateName: `${match[1]}.${field.name}`,
              setter: match[2],
              initialValue: compact(field.initialValue),
              file: file.file
            });
          }
        }
      }
    }
    return dedupe(records);
  }
}

function reducerInitialFields(content: string, initialArgument: string): Array<{ name: string; initialValue: string }> {
  const objectBody = objectInitializer(content, initialArgument);
  if (objectBody === undefined) {
    return [];
  }

  const fields: Array<{ name: string; initialValue: string }> = [];
  for (const property of splitTopLevel(objectBody)) {
    if (!property || property.startsWith("...") || property.startsWith("[")) {
      continue;
    }
    const named = property.match(/^\s*(?:([A-Za-z_$][A-Za-z0-9_$]*)|["'`]([^"'`]+)["'`])\s*:\s*([\s\S]+)$/);
    if (named) {
      fields.push({ name: named[1] ?? named[2], initialValue: named[3] });
      continue;
    }
    const shorthand = property.match(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*$/)?.[1];
    if (shorthand) {
      fields.push({ name: shorthand, initialValue: shorthand });
    }
  }
  return fields;
}

function objectInitializer(content: string, rawArgument: string): string | undefined {
  const argument = rawArgument.trim().replace(/\s+as\s+(?:const|[A-Za-z_$][A-Za-z0-9_$.<>\[\]|& ]*)\s*$/, "").trim();
  if (argument.startsWith("{")) {
    return readBalancedSource(argument, 0, "{", "}")?.content;
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(argument)) {
    return undefined;
  }
  const declaration = new RegExp(`\\bconst\\s+${escapeRegex(argument)}(?:\\s*:[^=;]+)?\\s*=\\s*`, "g").exec(content);
  if (!declaration) {
    return undefined;
  }
  const initializerStart = declaration.index + declaration[0].length;
  const openBrace = content.indexOf("{", initializerStart);
  if (openBrace < 0 || content.slice(initializerStart, openBrace).trim()) {
    return undefined;
  }
  return readBalancedSource(content, openBrace, "{", "}")?.content;
}

function functionNameNear(content: string, index: number): string | undefined {
  const before = content.slice(0, index);
  const pattern = /(?:function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(|const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>)/g;
  let selected: string | undefined;
  for (const match of before.matchAll(pattern)) {
    selected = match[1] ?? match[2] ?? selected;
  }
  return selected;
}

function fileOwner(file: string): string | undefined {
  const name = file.split("/").pop()?.replace(/\.(?:tsx|ts|jsx|js)$/i, "");
  return name && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : undefined;
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240) || "undefined";
}

function dedupe(records: ReactStateRecord[]): ReactStateRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.component}|${record.stateName}|${record.setter}|${record.file}`;
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
