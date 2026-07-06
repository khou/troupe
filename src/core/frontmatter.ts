/**
 * Minimal YAML frontmatter for trupe's markdown entities. Deliberately tiny:
 * flat string/number/boolean/string-array values only - enough for task and
 * proposal headers without pulling in a YAML dependency. Unknown keys pass
 * through untouched so humans can annotate freely.
 */

export type FrontmatterValue = string | number | boolean | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export interface ParsedDoc {
  data: Frontmatter;
  body: string;
}

export function parseDoc(raw: string): ParsedDoc {
  if (!raw.startsWith('---\n')) return { data: {}, body: raw };
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { data: {}, body: raw };
  const header = raw.slice(4, end);
  const body = raw.slice(end + 4).replace(/^\n/, '');
  const data: Frontmatter = {};
  for (const line of header.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    data[m[1]] = parseValue(m[2]);
  }
  return { data, body };
}

function parseValue(v: string): FrontmatterValue {
  const t = v.trim();
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((s) => unquote(s.trim()));
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return unquote(t);
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export function serializeDoc(data: Frontmatter, body: string): string {
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${serializeValue(v)}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`;
}

function serializeValue(v: FrontmatterValue): string {
  if (Array.isArray(v)) return `[${v.map(quoteIfNeeded).join(', ')}]`;
  if (typeof v === 'string') return quoteIfNeeded(v);
  return String(v);
}

function quoteIfNeeded(s: string): string {
  if (/^[A-Za-z0-9 ._@/-]*$/.test(s) && s.trim() === s && s !== '' && !/^(true|false|-?\d+(\.\d+)?)$/.test(s)) {
    return s;
  }
  return JSON.stringify(s);
}
