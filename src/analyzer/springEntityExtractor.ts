import { ScannedFile } from "./repositoryScanner";

export interface EntityIndex {
  entity: string;
  table?: string;
  idField?: string;
  fields: Array<{ name: string; type: string; column?: string }>;
  relationships: Array<{ field: string; type: string; targetType: string }>;
  file: string;
}

export class SpringEntityExtractor {
  extract(files: ScannedFile[]): EntityIndex[] {
    return files
      .filter((file) => file.kind === "java" && file.classification === "entity")
      .map((file) => this.extractOne(file))
      .filter((entity): entity is EntityIndex => Boolean(entity));
  }

  private extractOne(file: ScannedFile): EntityIndex | undefined {
    if (!/@Entity\b/.test(file.content)) {
      return undefined;
    }
    const entity = file.content.match(/\bclass\s+([A-Za-z0-9_]+)/)?.[1];
    if (!entity) {
      return undefined;
    }
    const fields = [...file.content.matchAll(/(?:@Column\((?:name\s*=\s*)?["']([^"']+)["']\)\s*)?(?:private|protected)\s+([A-Za-z0-9_<>]+)\s+([A-Za-z0-9_]+)\s*;/g)]
      .map((match) => ({ name: match[3], type: match[2], column: match[1] }));
    const relationships = [...file.content.matchAll(/@(OneToOne|OneToMany|ManyToOne|ManyToMany)\b[\s\S]{0,160}?(?:private|protected)\s+([A-Za-z0-9_<>]+)\s+([A-Za-z0-9_]+)\s*;/g)]
      .map((match) => ({ type: match[1], targetType: match[2], field: match[3] }));
    const idField = file.content.match(/@Id[\s\S]{0,120}?(?:private|protected)\s+[A-Za-z0-9_<>]+\s+([A-Za-z0-9_]+)\s*;/)?.[1];

    return {
      entity,
      table: extractTopLevelStringArgument(file.content, "Table", "name"),
      idField,
      fields,
      relationships,
      file: file.file
    };
  }
}

function extractTopLevelStringArgument(content: string, annotation: string, argument: string): string | undefined {
  const annotationMatch = new RegExp(`@${annotation}\\b`, "g").exec(content);
  if (!annotationMatch) {
    return undefined;
  }

  const openParenthesis = content.indexOf("(", annotationMatch.index + annotationMatch[0].length);
  if (openParenthesis < 0) {
    return undefined;
  }
  const betweenAnnotationAndArguments = content.slice(annotationMatch.index + annotationMatch[0].length, openParenthesis);
  if (betweenAnnotationAndArguments.trim()) {
    return undefined;
  }

  const closeParenthesis = findMatchingDelimiter(content, openParenthesis, "(", ")");
  if (closeParenthesis < 0) {
    return undefined;
  }

  const argumentsText = content.slice(openParenthesis + 1, closeParenthesis);
  for (const candidate of splitTopLevel(argumentsText, ",")) {
    const match = candidate.match(new RegExp(`^\\s*${argument}\\s*=\\s*(["'])(.*?)\\1\\s*$`, "s"));
    if (match) {
      return match[2];
    }
  }
  return undefined;
}

function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let parenthesisDepth = 0;
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
    if (char === "{") braceDepth++;
    if (char === "}") braceDepth--;
    if (char === "[") bracketDepth++;
    if (char === "]") bracketDepth--;

    if (char === separator && parenthesisDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function findMatchingDelimiter(content: string, start: number, open: string, close: string): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = start; index < content.length; index++) {
    const char = content[index];
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
    } else if (char === open) {
      depth++;
    } else if (char === close) {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}
