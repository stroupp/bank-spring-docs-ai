import { ScannedFile } from "../repositoryScanner";

export interface BffDtoRecord {
  className: string;
  packageName: string;
  file: string;
  fields: string[];
  validations: BffDtoValidation[];
  reason: string;
}

export interface BffDtoValidation {
  field: string;
  annotation: string;
  arguments?: string;
}

const dtoDirectoryNames = new Set([
  "dto", "dtos", "model", "models", "request", "requests", "response", "responses",
  "command", "commands", "query", "queries"
]);

const validationAnnotationNames = new Set([
  "AssertFalse", "AssertTrue", "DecimalMax", "DecimalMin", "Digits", "Email", "Future",
  "FutureOrPresent", "Max", "Min", "Negative", "NegativeOrZero", "NotBlank", "NotEmpty",
  "NotNull", "Null", "Past", "PastOrPresent", "Pattern", "Positive", "PositiveOrZero", "Size", "Valid"
]);

export class BffDtoExtractor {
  extract(files: ScannedFile[]): BffDtoRecord[] {
    return files
      .filter((file) => file.kind === "java")
      .map((file) => this.extractOne(file))
      .filter((record): record is BffDtoRecord => Boolean(record));
  }

  private extractOne(file: ScannedFile): BffDtoRecord | undefined {
    const className = file.content.match(/\b(?:class|record)\s+([A-Za-z0-9_]+)/)?.[1];
    if (!className) {
      return undefined;
    }
    const pathReason = hasDtoDirectory(file.file);
    const nameReason = /(Request|Response|Dto|DTO|Command|Query)$/i.test(className);
    if (!pathReason && !nameReason) {
      return undefined;
    }

    const classFields = extractClassFields(file.content);
    const recordFields = extractRecordFields(file.content, className);

    return {
      className,
      packageName: file.content.match(/\bpackage\s+([A-Za-z0-9_.]+)\s*;/)?.[1] ?? "",
      file: file.file,
      fields: unique([...recordFields.fields, ...classFields.fields]),
      validations: uniqueValidations([...recordFields.validations, ...classFields.validations]),
      reason: nameReason ? "class name suffix" : "package/path convention"
    };
  }
}

function hasDtoDirectory(filePath: string): boolean {
  const segments = filePath.replace(/\\/g, "/").split("/").slice(0, -1);
  return segments.some((segment) => segment.toLowerCase().split(/[-_.]/).some((part) => dtoDirectoryNames.has(part)));
}

function extractClassFields(content: string): { fields: string[]; validations: BffDtoValidation[] } {
  const fields: string[] = [];
  const validations: BffDtoValidation[] = [];
  const pattern = /((?:(?:@[A-Za-z_$][A-Za-z0-9_$.]*(?:\s*\([^)]*\))?\s*)*))\b(?:private|public|protected)\s+(?!static\b)(?:final\s+)?([A-Za-z_$][A-Za-z0-9_$.,?<> \[\]]*)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=[^;]*)?;/g;
  for (const match of content.matchAll(pattern)) {
    const field = match[3];
    fields.push(`${field}: ${normalizeType(match[2])}`);
    validations.push(...validationAnnotations(match[1], field));
  }
  return { fields, validations };
}

function extractRecordFields(content: string, className: string): { fields: string[]; validations: BffDtoValidation[] } {
  const header = new RegExp(`\\brecord\\s+${escapeRegExp(className)}(?:\\s*<[^>{}]*>)?\\s*\\(`).exec(content);
  if (!header) {
    return { fields: [], validations: [] };
  }
  const openParenthesis = (header.index ?? 0) + header[0].lastIndexOf("(");
  const closeParenthesis = findMatchingParenthesis(content, openParenthesis);
  if (closeParenthesis < 0) {
    return { fields: [], validations: [] };
  }

  const fields: string[] = [];
  const validations: BffDtoValidation[] = [];
  for (const rawComponent of splitTopLevel(content.slice(openParenthesis + 1, closeParenthesis))) {
    const component = stripLeadingAnnotations(rawComponent);
    const declaration = component.remainder.trim().replace(/^final\s+/, "").match(/^(.+?)\s+([A-Za-z_$][A-Za-z0-9_$]*)$/s);
    if (!declaration) {
      continue;
    }
    const field = declaration[2];
    fields.push(`${field}: ${normalizeType(declaration[1])}`);
    validations.push(...component.annotations
      .filter((annotation) => validationAnnotationNames.has(annotation.name))
      .map((annotation) => ({
        field,
        annotation: annotation.name,
        ...(annotation.arguments ? { arguments: annotation.arguments } : {})
      })));
  }
  return { fields, validations };
}

function validationAnnotations(value: string, field: string): BffDtoValidation[] {
  return [...value.matchAll(/@([A-Za-z_$][A-Za-z0-9_$.]*)(?:\s*\(([^)]*)\))?/g)]
    .map((match) => ({ name: match[1].split(".").pop() ?? match[1], arguments: match[2]?.trim() }))
    .filter((annotation) => validationAnnotationNames.has(annotation.name))
    .map((annotation) => ({
      field,
      annotation: annotation.name,
      ...(annotation.arguments ? { arguments: annotation.arguments } : {})
    }));
}

function stripLeadingAnnotations(value: string): {
  remainder: string;
  annotations: Array<{ name: string; arguments?: string }>;
} {
  const annotations: Array<{ name: string; arguments?: string }> = [];
  let index = 0;
  while (index < value.length) {
    while (/\s/.test(value[index] ?? "")) index++;
    if (value[index] !== "@") break;
    const nameMatch = value.slice(index + 1).match(/^([A-Za-z_$][A-Za-z0-9_$.]*)/);
    if (!nameMatch) break;
    const qualifiedName = nameMatch[1];
    index += 1 + qualifiedName.length;
    while (/\s/.test(value[index] ?? "")) index++;
    let argumentsText: string | undefined;
    if (value[index] === "(") {
      const close = findMatchingParenthesis(value, index);
      if (close < 0) break;
      argumentsText = value.slice(index + 1, close).trim() || undefined;
      index = close + 1;
    }
    annotations.push({
      name: qualifiedName.split(".").pop() ?? qualifiedName,
      ...(argumentsText ? { arguments: argumentsText } : {})
    });
  }
  return { remainder: value.slice(index), annotations };
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let parenthesisDepth = 0;
  let angleDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (const char of value) {
    if (quote) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") parenthesisDepth++;
    if (char === ")") parenthesisDepth--;
    if (char === "<") angleDepth++;
    if (char === ">") angleDepth--;
    if (char === "{") braceDepth++;
    if (char === "}") braceDepth--;
    if (char === "[") bracketDepth++;
    if (char === "]") bracketDepth--;
    if (char === "," && parenthesisDepth === 0 && angleDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    parts.push(current);
  }
  return parts;
}

function findMatchingParenthesis(value: string, openParenthesis: number): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = openParenthesis; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function normalizeType(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueValidations(values: BffDtoValidation[]): BffDtoValidation[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.field}\u0000${value.annotation}\u0000${value.arguments ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
