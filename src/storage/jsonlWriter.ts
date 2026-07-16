import * as fs from "fs/promises";
import { atomicWriteFile } from "./atomicFile";

export interface ReadJsonlOptions<T> {
  allowMissing?: boolean;
  validate?: (value: unknown) => value is T;
}

export type JsonlReadErrorCode = "JSONL_NOT_FOUND" | "JSONL_INVALID_JSON" | "JSONL_INVALID_RECORD";

export class JsonlReadError extends Error {
  constructor(
    message: string,
    readonly code: JsonlReadErrorCode,
    readonly filePath: string,
    readonly lineNumber?: number
  ) {
    super(message);
    this.name = "JsonlReadError";
  }
}

export async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  const lines = records.map((record, index) => {
    const serialized = JSON.stringify(record);
    if (serialized === undefined) {
      throw new Error(`JSONL record ${index + 1} in ${filePath} cannot be serialized.`);
    }
    return serialized;
  });
  await atomicWriteFile(filePath, lines.length ? `${lines.join("\n")}\n` : "");
}

export async function readJsonl<T>(filePath: string, options: ReadJsonlOptions<T> = {}): Promise<T[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.allowMissing !== false) {
      return [];
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new JsonlReadError(`Required JSONL file is missing: ${filePath}.`, "JSONL_NOT_FOUND", filePath);
    }
    throw error;
  }

  const records: T[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const normalizedLine = index === 0 ? line.replace(/^\uFEFF/, "") : line;
    if (!normalizedLine.trim()) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(normalizedLine);
    } catch {
      throw new JsonlReadError(`Malformed JSONL in ${filePath} at line ${index + 1}.`, "JSONL_INVALID_JSON", filePath, index + 1);
    }
    if (options.validate && !options.validate(value)) {
      throw new JsonlReadError(`Invalid JSONL record in ${filePath} at line ${index + 1}.`, "JSONL_INVALID_RECORD", filePath, index + 1);
    }
    records.push(value as T);
  }
  return records;
}

export function readRequiredJsonl<T>(filePath: string, options: Omit<ReadJsonlOptions<T>, "allowMissing"> = {}): Promise<T[]> {
  return readJsonl(filePath, { ...options, allowMissing: false });
}
