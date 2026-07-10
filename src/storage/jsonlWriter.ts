import * as fs from "fs/promises";
import * as path from "path";

export async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content = records.map((record) => JSON.stringify(record)).join("\n");
  await fs.writeFile(filePath, content ? `${content}\n` : "", "utf8");
}

export async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}
