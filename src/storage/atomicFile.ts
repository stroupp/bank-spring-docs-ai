import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";

const retryableRenameCodes = new Set(["EACCES", "EBUSY", "EPERM"]);

export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx");
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(temporaryPath, filePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new Error(`JSON artifact ${filePath} cannot be serialized.`);
  }
  await atomicWriteFile(filePath, `${serialized}\n`);
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  const delays = [0, 20, 60, 140, 300];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay) {
      await wait(delay);
    }
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !retryableRenameCodes.has(code)) {
        throw error;
      }
    }
  }
  throw lastError;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
