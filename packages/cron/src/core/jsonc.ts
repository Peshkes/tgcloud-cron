/**
 * Parses JSON with `//` and `/* *\/` comments and trailing commas, the same
 * dialect as `tgcloud.jsonc`. Comments become spaces, so JSON.parse error
 * positions still point at the right place.
 */
export function parseJsonc(text: string): unknown {
  // Windows editors may save a byte order mark, which JSON.parse rejects.
  return JSON.parse(stripJsonc(text.replace(/^\uFEFF/, '')));
}

export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  let inString = false;
  while (i < n) {
    const ch = text[i] as string;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (; i < stop; i++) out += text[i] === '\n' ? '\n' : ' ';
      continue;
    }
    out += ch;
    i++;
  }
  // The first alternative matches whole strings so commas inside them survive.
  return out.replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (_m, str, close) => str ?? close);
}
