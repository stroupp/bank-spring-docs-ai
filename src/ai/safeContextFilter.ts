export function maskSecrets(input: string): string {
  return maskSecretsWithStats(input).text;
}

export function maskSecretsWithStats(input: string): { text: string; maskedSecrets: number } {
  let maskedSecrets = 0;
  const replace = (_match: string, prefix?: string) => {
    maskedSecrets += 1;
    return prefix ? `${prefix}[MASKED_SECRET]` : "[MASKED_SECRET]";
  };
  const replaceDoubleQuoted = (_match: string, prefix: string) => {
    maskedSecrets += 1;
    return `${prefix}"[MASKED_SECRET]"`;
  };
  const replaceSingleQuoted = (_match: string, prefix: string) => {
    maskedSecrets += 1;
    return `${prefix}'[MASKED_SECRET]'`;
  };
  const replaceQuotedScalar = (_match: string, prefix: string) => {
    maskedSecrets += 1;
    return `${prefix}"[MASKED_SECRET]"`;
  };

  const text = input
    // JSON and object-literal keys have a quote between the sensitive key and
    // the colon, so the legacy key=value expression below cannot see them.
    // Preserve the surrounding syntax so persisted debug JSON remains valid.
    .replace(/("(?:password|token|secret|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization)"\s*:\s*)"(?:\\.|[^"\\\r\n])*"/gi, replaceDoubleQuoted)
    .replace(/('(?:password|token|secret|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization)'\s*:\s*)'(?:\\.|[^'\\\r\n])*'/gi, replaceSingleQuoted)
    .replace(/(["'](?:password|token|secret|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization)["']\s*:\s*)(?!["'])[^,\s}\]]+/gi, replaceQuotedScalar)
    .replace(/((?:password|token|secret|api[_-]?key|client[_-]?secret|authorization)\s*[:=]\s*)"(?:\\.|[^"\\\r\n])*"/gi, replaceDoubleQuoted)
    .replace(/((?:password|token|secret|api[_-]?key|client[_-]?secret|authorization)\s*[:=]\s*)'(?:\\.|[^'\\\r\n])*'/gi, replaceSingleQuoted)
    .replace(/((?:password|token|secret|api[_-]?key|client[_-]?secret)\s*[:=]\s*)(?!["'])[^"'\s]+/gi, replace)
    .replace(/(authorization:\s*)(bearer\s+)?[A-Za-z0-9._~+/=-]+/gi, (_match, prefix) => replace(_match, prefix))
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, () => replace(""));

  return { text, maskedSecrets };
}

export function legacyMaskSecrets(input: string): string {
  return input
    .replace(/(password|token|secret|api[_-]?key|client[_-]?secret)\s*[:=]\s*["']?[^"'\s]+/gi, "$1=[MASKED_SECRET]")
    .replace(/(authorization:\s*)(bearer\s+)?[A-Za-z0-9._~+/=-]+/gi, "$1[MASKED_SECRET]")
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[MASKED_SECRET]");
}
