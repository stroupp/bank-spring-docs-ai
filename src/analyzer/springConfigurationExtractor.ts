import { ScannedFile } from "./repositoryScanner";

export interface ConfigurationIndex {
  file: string;
  keys: string[];
}

export class SpringConfigurationExtractor {
  extract(files: ScannedFile[]): ConfigurationIndex[] {
    return files.filter((file) => file.kind === "config").map((file) => ({
      file: file.file,
      keys: file.content
        .split(/\r?\n/)
        .map((line) => line.trim().match(/^([A-Za-z0-9_.-]+)\s*[:=]/)?.[1])
        .filter((key): key is string => Boolean(key))
        .map((key) => maskSensitiveKey(key))
    }));
  }
}

function maskSensitiveKey(key: string): string {
  return /(password|token|secret|key|credential|connection-string)/i.test(key) ? `${key}=[MASKED_SECRET]` : key;
}
