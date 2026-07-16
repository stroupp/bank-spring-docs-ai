export interface BalancedSource {
  content: string;
  end: number;
}

export interface JsxOpeningTag {
  name: string;
  attributes: string;
  start: number;
  end: number;
}

export function readBalancedSource(source: string, openIndex: number, open = "(", close = ")"): BalancedSource | undefined {
  if (source[openIndex] !== open) {
    return undefined;
  }

  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) {
        return { content: source.slice(openIndex + 1, index), end: index + 1 };
      }
    }
  }
  return undefined;
}

export function splitTopLevel(source: string, delimiter = ","): string[] {
  const parts: string[] = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let angle = 0;
  let quote: string | undefined;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") round += 1;
    else if (character === ")") round = Math.max(0, round - 1);
    else if (character === "[") square += 1;
    else if (character === "]") square = Math.max(0, square - 1);
    else if (character === "{") curly += 1;
    else if (character === "}") curly = Math.max(0, curly - 1);
    else if (character === "<" && looksLikeTypeArgumentStart(source, index)) angle += 1;
    else if (character === ">" && angle > 0) angle -= 1;
    else if (character === delimiter && round === 0 && square === 0 && curly === 0 && angle === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

export function findCallOpenParen(source: string, afterCallee: number): number | undefined {
  let index = skipWhitespace(source, afterCallee);
  if (source[index] === "<") {
    const genericEnd = findMatchingAngle(source, index);
    if (genericEnd === undefined) {
      return undefined;
    }
    index = skipWhitespace(source, genericEnd);
  }
  return source[index] === "(" ? index : undefined;
}

export function findJsxOpeningTags(source: string, acceptedNames?: ReadonlySet<string>): JsxOpeningTag[] {
  const tags: JsxOpeningTag[] = [];
  const pattern = /<([A-Za-z][A-Za-z0-9.]*)\b/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (acceptedNames && !acceptedNames.has(name)) {
      continue;
    }
    const start = match.index ?? 0;
    const attributesStart = start + match[0].length;
    const end = findJsxTagEnd(source, attributesStart);
    if (end === undefined) {
      continue;
    }
    tags.push({ name, attributes: source.slice(attributesStart, end - 1), start, end });
  }
  return tags;
}

export function literalJsxAttribute(attributes: string, attribute: string): string | undefined {
  const escaped = escapeRegex(attribute);
  const pattern = "(?:^|\\s)" + escaped + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|\\{\\s*(?:\"([^\"]*)\"|'([^']*)'|`([^`]*)`)\\s*\\})";
  const match = attributes.match(new RegExp(pattern));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4] ?? match?.[5];
}

export function jsxAttributeExpression(attributes: string, attribute: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${escapeRegex(attribute)}\\s*=\\s*`).exec(attributes);
  if (!match) {
    return undefined;
  }
  const valueStart = skipWhitespace(attributes, match.index + match[0].length);
  if (attributes[valueStart] === "{") {
    return readBalancedSource(attributes, valueStart, "{", "}")?.content.trim();
  }
  const quote = attributes[valueStart];
  if (quote === "\"" || quote === "'" || quote === "`") {
    const end = findQuoteEnd(attributes, valueStart, quote);
    return end === undefined ? undefined : attributes.slice(valueStart + 1, end);
  }
  return undefined;
}

function findJsxTagEnd(source: string, start: number): number | undefined {
  let curly = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") {
      curly += 1;
    } else if (character === "}") {
      curly = Math.max(0, curly - 1);
    } else if (character === ">" && curly === 0) {
      return index + 1;
    }
  }
  return undefined;
}

function findMatchingAngle(source: string, start: number): number | undefined {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "<") {
      depth += 1;
    } else if (character === ">") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return undefined;
}

function looksLikeTypeArgumentStart(source: string, index: number): boolean {
  const before = source.slice(Math.max(0, index - 20), index);
  const after = source.slice(index + 1, index + 21);
  return /[A-Za-z0-9_$.)\]]\s*$/.test(before) && /^\s*[A-Za-z_$][A-Za-z0-9_$<>,.?\s\[\]|&]*>/.test(after);
}

function findQuoteEnd(source: string, start: number, quote: string): number | undefined {
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === quote) {
      return index;
    }
  }
  return undefined;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (/\s/.test(source[index] ?? "")) {
    index += 1;
  }
  return index;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
