import { ScannedFile } from "../repositoryScanner";

export interface JavaMethodCallRecord {
  className: string;
  methodName: string;
  targetVariable: string;
  targetType?: string;
  targetMethod: string;
  file: string;
  confidence: "high" | "medium" | "low";
}

export class JavaMethodCallExtractor {
  extract(files: ScannedFile[]): JavaMethodCallRecord[] {
    return files
      .filter((file) => file.kind === "java")
      .flatMap((file) => this.extractOne(file));
  }

  private extractOne(file: ScannedFile): JavaMethodCallRecord[] {
    const className = file.content.match(/\b(?:class|interface)\s+([A-Za-z0-9_]+)/)?.[1];
    if (!className) {
      return [];
    }

    const dependencies = dependencyVariables(file.content, className);
    const records: JavaMethodCallRecord[] = [];
    for (const method of methodBodies(file.content)) {
      for (const call of method.body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
        const targetVariable = call[1];
        const targetMethod = call[2];
        if (ignoredReceiver(targetVariable)) {
          continue;
        }
        const targetType = dependencies.get(targetVariable) ?? classLikeReceiver(targetVariable);
        records.push({
          className,
          methodName: method.name,
          targetVariable,
          ...(targetType ? { targetType } : {}),
          targetMethod,
          file: file.file,
          confidence: targetType ? "high" : "medium"
        });
      }
    }

    return records;
  }
}

function dependencyVariables(content: string, className: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of content.matchAll(/(?:private|protected|public)?\s*(?:final\s+)?([A-Z][A-Za-z0-9_<>]*)\s+([a-z][A-Za-z0-9_]*)\s*;/g)) {
    result.set(match[2], rawType(match[1]));
  }

  const constructor = content.match(new RegExp(`${className}\\s*\\(([^)]*)\\)`));
  if (constructor) {
    for (const param of splitParams(constructor[1])) {
      const match = param.trim().match(/(?:final\s+)?([A-Z][A-Za-z0-9_<>]*)\s+([a-z][A-Za-z0-9_]*)$/);
      if (match) {
        result.set(match[2], rawType(match[1]));
      }
    }
  }

  return result;
}

function methodBodies(content: string): Array<{ name: string; body: string }> {
  const methods: Array<{ name: string; body: string }> = [];
  const signatureRegex = /(?:public|private|protected)\s+(?:static\s+)?[A-Za-z0-9_<>,.? \[\]]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((?:[^()]|\([^()]*\))*\)\s*(?:throws\s+[A-Za-z0-9_,\s]+)?\s*\{/g;
  for (const match of content.matchAll(signatureRegex)) {
    const openBrace = (match.index ?? 0) + match[0].length - 1;
    const closeBrace = findMatchingBrace(content, openBrace);
    if (closeBrace > openBrace) {
      methods.push({ name: match[1], body: content.slice(openBrace + 1, closeBrace) });
    }
  }
  return methods;
}

function findMatchingBrace(content: string, openBrace: number): number {
  let depth = 0;
  for (let index = openBrace; index < content.length; index++) {
    const char = content[index];
    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function splitParams(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let angleDepth = 0;
  for (const char of value) {
    if (char === "<") {
      angleDepth++;
    } else if (char === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
    }
    if (char === "," && angleDepth === 0) {
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

function rawType(value: string): string {
  return value.replace(/<.*>/g, "").trim();
}

function classLikeReceiver(value: string): string | undefined {
  return /^[A-Z]/.test(value) ? value : undefined;
}

function ignoredReceiver(value: string): boolean {
  return ["this", "super", "log", "logger", "System", "Objects", "Collections", "Stream"].includes(value);
}
