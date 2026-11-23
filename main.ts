// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface SplitFile {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): SplitFile {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(f: SplitFile): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function normLine(s: string, tier: number): string {
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  if (tier === 2) return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return s;
}

/** Positions where O occurs in fileLines at the given tier, at or after `from`. */
function occurrencesAt(fileLines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const on = o.map((l) => normLine(l, tier));
  for (let i = from; i + o.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (normLine(fileLines[i + k]!, tier) !== on[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; strict: only 0) at which O occurs, with its positions. */
function findTier(fileLines: string[], o: string[], strict: boolean, from = 0, eof = false): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier += 1) {
    let pos = occurrencesAt(fileLines, o, tier, from);
    if (eof) pos = pos.filter((p) => p + o.length === fileLines.length);
    if (pos.length > 0) return { tier, positions: pos };
  }
  return null;
}

/** One line of a replacement: `ctx` is the index into O when it is a context line, else -1. */
interface NewLine {
  text: string;
  ctx: number;
}

function buildReplacement(fileLines: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  if (tier !== 2) return n.map((e) => (e.ctx >= 0 ? fileLines[pos + e.ctx]! : e.text));
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  const f = fileLines[pos] !== undefined ? leadingWs(fileLines[pos]!) : '';
  return n.map((e) => {
    if (e.ctx >= 0) return fileLines[pos + e.ctx]!;
    const t = e.text;
    if (t === '' || t.trim() === '') return t;
    if (p !== '' && !t.startsWith(p)) return t;
    return f + t.slice(p.length);
  });
}

function plainLines(lines: string[]): NewLine[] {
  return lines.map((text) => ({ text, ctx: -1 }));
}


/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Unified diffs (SPEC.md section 6) ---- */

interface HunkBody {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

interface Hunk {
  a: number;
  body: HunkBody[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noEolAfterPlus: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function stripPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

function parseHunkBody(lines: string[], start: number): { hunk: Hunk; next: number } {
  const raw: Array<HunkBody | { kind: 'mark' }> = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line === '') raw.push({ kind: 'ctx', text: '' });
    else if (line[0] === ' ') raw.push({ kind: 'ctx', text: line.slice(1) });
    else if (line[0] === '-') raw.push({ kind: 'old', text: line.slice(1) });
    else if (line[0] === '+') raw.push({ kind: 'new', text: line.slice(1) });
    else if (line[0] === '\\') raw.push({ kind: 'mark' });
    else break;
    i += 1;
  }
  let noEol = false;
  let noEolAfterPlus = false;
  let lastCtxNew = -1;
  let lastPlus = -1;
  for (let k = 0; k < raw.length; k += 1) {
    if (raw[k]!.kind === 'ctx' || raw[k]!.kind === 'new') lastCtxNew = k;
    if (raw[k]!.kind === 'new') lastPlus = k;
  }
  if (lastCtxNew >= 0 && raw[lastCtxNew + 1] !== undefined && raw[lastCtxNew + 1]!.kind === 'mark') noEol = true;
  if (lastPlus >= 0 && raw[lastPlus + 1] !== undefined && raw[lastPlus + 1]!.kind === 'mark') noEolAfterPlus = true;
  const body = raw.filter((e): e is HunkBody => e.kind !== 'mark');
  while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
  return { hunk: { a: 0, body, noEol, noEolAfterPlus }, next: i };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const startSection = (sec: UniSection): void => {
    sections.push(sec);
    cur = sec;
    inHeader = true;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const diffM = /^diff --git a\/(.+) b\/(.+)$/.exec(line) ?? /^diff --git "a\/(.+)" "b\/(.+)"$/.exec(line);
    if (line.startsWith('diff --git ')) {
      if (diffM === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection({ oldPath: stripPrefix(diffM[1]!), newPath: stripPrefix(diffM[2]!), newFile: false, deletedFile: false, hunks: [] });
      // Keep the diff paths as fallbacks, stored on the section itself below.
      (cur as UniSection & { diffOld?: string; diffNew?: string }).diffOld = stripPrefix(diffM[1]!);
      (cur as UniSection & { diffOld?: string; diffNew?: string }).diffNew = stripPrefix(diffM[2]!);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const ext = cur as (UniSection & { hasPair?: boolean }) | null;
      if (cur === null || !inHeader || (ext !== null && ext.hasPair === true)) {
        // A ---/+++ pair starts a new section, except the first pair of a
        // section already started by `diff --git`, which is its header.
        startSection({ oldPath: null, newPath: null, newFile: false, deletedFile: false, hunks: [] });
      }
      cur!.oldPath = headerPath(line) === '/dev/null' ? null : stripPrefix(headerPath(line));
      cur!.newPath = headerPath(lines[i + 1]!) === '/dev/null' ? null : stripPrefix(headerPath(lines[i + 1]!));
      (cur as UniSection & { hasPair?: boolean }).hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?: .*)?$/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = parseHunkBody(lines, i + 1);
      parsed.hunk.a = Number(hm[1]);
      cur.hunks.push(parsed.hunk);
      inHeader = false;
      i = parsed.next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        const p = line.slice('rename from '.length).trim();
        (cur as UniSection & { renameFrom?: string }).renameFrom = p;
      } else if (line.startsWith('rename to ')) {
        const p = line.slice('rename to '.length).trim();
        (cur as UniSection & { renameTo?: string }).renameTo = p;
      } else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  const edits: Edit[] = [];
  for (const sec of sections) {
    const ext = sec as UniSection & { diffOld?: string; diffNew?: string; renameFrom?: string; renameTo?: string; hasPair?: boolean };
    const oldP = sec.oldPath ?? ext.renameFrom ?? ext.diffOld ?? null;
    const newP = sec.newPath ?? ext.renameTo ?? ext.diffNew ?? null;
    const isCreate = oldP === null || sec.newFile;
    const isDelete = newP === null || sec.deletedFile;
    edits.push((tree) => {
      if (isCreate) {
        const p = newP!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const added: string[] = [];
        for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'new') added.push(b.text);
        let noEol = false;
        for (let k = sec.hunks.length - 1; k >= 0; k -= 1) {
          if (sec.hunks[k]!.body.some((b) => b.kind === 'new')) {
            noEol = sec.hunks[k]!.noEolAfterPlus;
            break;
          }
        }
        tree.now.set(p, added.length === 0 ? '' : added.join('\n') + (noEol ? '' : '\n'));
        return;
      }
      if (isDelete) {
        const p = oldP!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const oldPath = oldP!;
      const newPath = newP!;
      const isMove = oldPath !== newPath;
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (isMove && !safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const f = splitFile(before);
      let d = 0;
      for (const h of sec.hunks) {
        const o: string[] = [];
        const n: NewLine[] = [];
        for (const b of h.body) {
          if (b.kind === 'ctx') {
            o.push(b.text);
            n.push({ text: b.text, ctx: o.length - 1 });
          } else if (b.kind === 'old') o.push(b.text);
          else n.push({ text: b.text, ctx: -1 });
        }
        if (o.length > 0) {
          const found = findTier(f.lines, o, strict);
          if (found === null) throw new Fail('no-match', oldPath);
          const target = h.a - 1 + d;
          let pos = found.positions[0]!;
          for (const p of found.positions) {
            if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
          }
          const atEnd = pos + o.length === f.lines.length;
          const repl = buildReplacement(f.lines, pos, o, n, found.tier);
          f.lines.splice(pos, o.length, ...repl);
          if (atEnd) f.final = !h.noEol;
          d += n.length - o.length;
        } else {
          const insertAt = Math.min(h.a + d, f.lines.length);
          const atEnd = insertAt === f.lines.length;
          const repl = buildReplacement(f.lines, insertAt, o, n, 0);
          f.lines.splice(insertAt, 0, ...repl);
          if (atEnd) f.final = !h.noEol;
          d += n.length;
        }
      }
      const out = joinFile(f);
      if (isMove) {
        tree.now.set(newPath, out);
        tree.now.set(oldPath, null);
        tree.recordMove(oldPath, newPath);
      } else {
        tree.now.set(oldPath, out);
      }
    });
  }
  return edits;
}

/* ---- SEARCH/REPLACE blocks (SPEC.md section 7) ---- */

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let nextSearch = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        nextSearch = j;
        break;
      }
    }
    let eq = -1;
    for (let j = i + 1; j < nextSearch; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < nextSearch; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const repl = buildReplacement(f.lines, pos, oldLines, plainLines(newLines), found.tier);
      f.lines.splice(pos, oldLines.length, ...repl);
      tree.now.set(p, joinFile(f));
    });
    prevPath = p;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* ---- V4A patches (SPEC.md section 8) ---- */

interface V4aChunk {
  anchor: string | null;
  body: HunkBody[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
  updateLine: number;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File:') || line.startsWith('*** Delete File:') || line.startsWith('*** Update File:')) {
      const kind = line.startsWith('*** Add File:') ? 'add' : line.startsWith('*** Delete File:') ? 'delete' : 'update';
      const path = line.slice(line.indexOf(':') + 1).trim();
      const sec: V4aSection = { kind, path, moveTo: null, lines: [], chunks: [], updateLine: i + 1 };
      i += 1;
      if (kind === 'add') {
        const raw: Array<{ text: string; empty: boolean }> = [];
        while (i < last && !isSectionStart(lines[i]!)) {
          const l = lines[i]!;
          if (l.startsWith('+')) raw.push({ text: l.slice(1), empty: false });
          else if (l === '') raw.push({ text: '', empty: true });
          else throw new Exit2(`error: parse ${i + 1}`);
          i += 1;
        }
        while (raw.length > 0 && raw[raw.length - 1]!.empty) raw.pop();
        sec.lines = raw.map((r) => r.text);
      } else if (kind === 'delete') {
        while (i < last && !isSectionStart(lines[i]!)) {
          if (blank(lines[i]!)) {
            i += 1;
            continue;
          }
          throw new Exit2(`error: parse ${i + 1}`);
        }
      } else {
        let cur: V4aChunk | null = null;
        let seenMove = false;
        let seenChunk = false;
        const pushChunk = (): void => {
          if (cur !== null) {
            sec.chunks.push(cur);
            cur = null;
          }
        };
        while (i < last && !isSectionStart(lines[i]!)) {
          const l = lines[i]!;
          if (l.startsWith('*** Move to:')) {
            if (seenMove || seenChunk || cur !== null) throw new Exit2(`error: parse ${i + 1}`);
            sec.moveTo = l.slice('*** Move to:'.length).trim();
            seenMove = true;
            i += 1;
            continue;
          }
          if (l === '*** End of File') {
            if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
            cur.eof = true;
            pushChunk();
            seenChunk = true;
            i += 1;
            continue;
          }
          if (l.startsWith('@@')) {
            pushChunk();
            cur = { anchor: l.slice(2).trim(), body: [], eof: false };
            seenChunk = true;
            i += 1;
            continue;
          }
          if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
            if (cur === null) {
              if (l === '') {
                i += 1;
                continue;
              }
              cur = { anchor: null, body: [], eof: false };
              seenChunk = true;
            }
            if (l === '') cur.body.push({ kind: 'ctx', text: '' });
            else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1) });
            else if (l[0] === '-') cur.body.push({ kind: 'old', text: l.slice(1) });
            else cur.body.push({ kind: 'new', text: l.slice(1) });
            i += 1;
            continue;
          }
          throw new Exit2(`error: parse ${i + 1}`);
        }
        pushChunk();
        // Blank lines at the end of the section are not part of it.
        const lastChunk = sec.chunks[sec.chunks.length - 1];
        if (lastChunk !== undefined && !lastChunk.eof) {
          while (lastChunk.body.length > 0 && lastChunk.body[lastChunk.body.length - 1]!.kind === 'ctx' && lastChunk.body[lastChunk.body.length - 1]!.text === '') lastChunk.body.pop();
        }
        if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.updateLine}`);
      }
      sections.push(sec);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  const edits: Edit[] = [];
  for (const sec of sections) {
    edits.push((tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (sec.kind === 'add') {
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
        return;
      }
      if (sec.kind === 'delete') {
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
        return;
      }
      if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      const before = tree.get(sec.path);
      if (before === null) throw new Fail('missing', sec.path);
      if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      const f = splitFile(before);
      let cursor = 0;
      for (const chunk of sec.chunks) {
        if (chunk.anchor !== null) {
          let foundIdx: number | null = null;
          const maxTier = strict ? 0 : 2;
          for (let tier = 0; tier <= maxTier && foundIdx === null; tier += 1) {
            for (let k = cursor; k < f.lines.length; k += 1) {
              if (normLine(f.lines[k]!, tier) === normLine(chunk.anchor!, tier)) {
                foundIdx = k;
                break;
              }
            }
          }
          if (foundIdx === null) throw new Fail('no-match', sec.path);
          cursor = foundIdx + 1;
        }
        const o: string[] = [];
        const n: NewLine[] = [];
        for (const b of chunk.body) {
          if (b.kind === 'ctx') {
            o.push(b.text);
            n.push({ text: b.text, ctx: o.length - 1 });
          } else if (b.kind === 'old') o.push(b.text);
          else n.push({ text: b.text, ctx: -1 });
        }
        if (o.length > 0) {
          const found = findTier(f.lines, o, strict, cursor, chunk.eof);
          if (found === null) throw new Fail('no-match', sec.path);
          const pos = found.positions[0]!;
          const repl = buildReplacement(f.lines, pos, o, n, found.tier);
          f.lines.splice(pos, o.length, ...repl);
          cursor = pos + repl.length;
        } else {
          const insertAt = chunk.eof ? f.lines.length : cursor;
          const repl = buildReplacement(f.lines, insertAt, o, n, 0);
          f.lines.splice(insertAt, 0, ...repl);
          cursor = insertAt + repl.length;
        }
      }
      const out = joinFile(f);
      if (sec.moveTo !== null) {
        tree.now.set(sec.moveTo, out);
        tree.now.set(sec.path, null);
        tree.recordMove(sec.path, sec.moveTo);
      } else {
        tree.now.set(sec.path, out);
      }
    });
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      for (const m of beforeMoves) tree.moves.push(m);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moveMap = new Map<string, string>();
  for (const [a, b] of tree.moves) {
    let key: string | null = null;
    for (const [k, v] of moveMap) {
      if (v === a) {
        key = k;
        break;
      }
    }
    if (key !== null) moveMap.set(key, b);
    else moveMap.set(a, b);
  }
  const paired = new Set<string>();
  const rows: Array<{ key: string; text: string }> = [];
  for (const [a, b] of moveMap) {
    if (tree.original(a) !== null && tree.now.get(a) === null && tree.original(b) === null && tree.now.get(b) !== null) {
      rows.push({ key: b, text: `R ${a} -> ${b}` });
      paired.add(a);
      paired.add(b);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (paired.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
