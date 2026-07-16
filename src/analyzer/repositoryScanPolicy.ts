export interface ScanCancellationToken {
  readonly isCancellationRequested: boolean;
}

export interface RepositoryScanOptions {
  maxFiles?: number;
  maxFileSizeBytes?: number;
  maxTotalBytes?: number;
  cancellationToken?: ScanCancellationToken;
}

export const defaultRepositoryScanLimits = {
  maxFiles: 50_000,
  maxFileSizeBytes: 5 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024
} as const;

export class RepositoryScanCancelledError extends Error {
  constructor() {
    super("Repository scan was cancelled.");
    this.name = "RepositoryScanCancelledError";
  }
}

export class RepositoryScanLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryScanLimitError";
  }
}

export class RepositoryScanBudget {
  private readonly maxFiles: number;
  private readonly maxFileSizeBytes: number;
  private readonly maxTotalBytes: number;
  private files = 0;
  private bytes = 0;

  constructor(private readonly options: RepositoryScanOptions = {}) {
    this.maxFiles = positiveInteger(options.maxFiles ?? defaultRepositoryScanLimits.maxFiles, "maxFiles");
    this.maxFileSizeBytes = positiveInteger(options.maxFileSizeBytes ?? defaultRepositoryScanLimits.maxFileSizeBytes, "maxFileSizeBytes");
    this.maxTotalBytes = positiveInteger(options.maxTotalBytes ?? defaultRepositoryScanLimits.maxTotalBytes, "maxTotalBytes");
  }

  checkCancellation(): void {
    if (this.options.cancellationToken?.isCancellationRequested) {
      throw new RepositoryScanCancelledError();
    }
  }

  assertReadable(relativePath: string, size: number): void {
    this.checkCancellation();
    if (size > this.maxFileSizeBytes) {
      throw new RepositoryScanLimitError(
        `Repository scan stopped because ${relativePath} is ${size} bytes; the per-file limit is ${this.maxFileSizeBytes} bytes.`
      );
    }
    if (this.files + 1 > this.maxFiles) {
      throw new RepositoryScanLimitError(`Repository scan stopped after ${this.files} files; the limit is ${this.maxFiles} files.`);
    }
    if (this.bytes + size > this.maxTotalBytes) {
      throw new RepositoryScanLimitError(
        `Repository scan stopped before ${relativePath}; the total content limit is ${this.maxTotalBytes} bytes.`
      );
    }
  }

  commit(relativePath: string, actualSize: number): void {
    this.assertReadable(relativePath, actualSize);
    this.files += 1;
    this.bytes += actualSize;
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Repository scan option ${label} must be a positive integer.`);
  }
  return value;
}
