// git.ts — the forge's git object model and packfile codec, written from the git
// format itself: object hashing, commit/tree/tag parsing and building, reachability,
// packfile read (with OFS/REF delta resolution) and write, tree diffing and three-way
// merge. Pure functions over an object lookup; no store, no I/O.
//
// Only Node built-ins are used (node:crypto for SHA-1, node:zlib for pack streams).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The four object types git stores. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** One git object: its type and its exact content bytes (no header). */
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** A lookup from object id to object; the store supplies it. */
export type ObjectLookup = (oid: string) => GitObject | undefined;

/** The all-zero id: an unborn ref's value. */
export const ZERO_OID = '0'.repeat(40);

const OID_RE = /^[0-9a-f]{40}$/;

/** True for a lowercase 40-hex object id. */
export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + content. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

/** One tree entry, as stored: an ASCII octal mode, a name and a 20-byte id. */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object's bytes into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------------------------

/** A parsed commit: its tree, parents, identity lines and message bytes as text. */
export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Split a commit/tag object's header block from its message. */
function splitHeader(data: Buffer): { headerText: string; message: string } {
  const blank = data.indexOf('\n\n');
  if (blank < 0) return { headerText: data.toString('utf8'), message: '' };
  return { headerText: data.subarray(0, blank).toString('utf8'), message: data.subarray(blank + 2).toString('utf8') };
}

/** Parse a commit object. Continuation lines (a leading space) fold into the previous header. */
export function parseCommit(data: Buffer): CommitView {
  const { headerText, message } = splitHeader(data);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let lastKey = '';
  for (const rawLine of headerText.split('\n')) {
    if (rawLine.startsWith(' ') && lastKey !== '') continue; // a folded header value: not modelled
    const space = rawLine.indexOf(' ');
    const key = space < 0 ? rawLine : rawLine.slice(0, space);
    const value = space < 0 ? '' : rawLine.slice(space + 1);
    lastKey = key;
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

/**
 * Build a commit object's bytes. `author`/`committer` are full identity lines
 * (`Name <email> <unix seconds> <timezone>`); `message` is stored byte for byte.
 */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** A parsed annotated tag. */
export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const { headerText, message } = splitHeader(data);
  const headers = new Map<string, string>();
  for (const line of headerText.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return { object, type, tag: headers.get('tag') ?? '', tagger: headers.get('tagger') ?? '', message };
}

/** Build an annotated tag object's bytes; the message is stored byte for byte. */
export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}): Buffer {
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n${fields.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree -> entries
 * (gitlinks skipped: they name commits this repository does not hold), tag -> target.
 * Throws on a missing object unless `allowMissing` is set.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const root of roots) if (isOid(root)) stack.push(root);
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) {
      if (options.allowMissing === true) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        stack.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Follow tag objects until a non-tag object; null when an object is missing. */
export function peelToNonTag(oid: string, lookup: ObjectLookup): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = lookup(current);
    if (object === undefined) return null;
    if (object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
}

/** True when `ancestor` equals `descendant` or is reachable from it through parents. */
export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  const from = peelToNonTag(descendant, lookup);
  const target = peelToNonTag(ancestor, lookup);
  if (from === null || target === null) return false;
  if (from === target) return true;
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === target) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/**
 * A merge base of two commits: the common ancestor closest to `b` by breadth-first
 * generations. Exact for the linear and simply-branched histories a forge checks use.
 */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const tipA = peelToNonTag(a, lookup);
  const tipB = peelToNonTag(b, lookup);
  if (tipA === null || tipB === null) return null;
  const ancestorsA = new Set<string>();
  const stackA = [tipA];
  while (stackA.length > 0) {
    const oid = stackA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = lookup(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) stackA.push(parent);
    }
  }
  const seenB = new Set<string>();
  const queue: string[] = [tipB];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (ancestorsA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const object = lookup(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  }
  return null;
}

/** A commit history walk from `tip`: depth-first pre-order, parents after the commit, deduplicated. */
export function commitHistory(tip: string, lookup: ObjectLookup): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    order.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
  }
  return order;
}

/**
 * Resolve a revision to a commit id: a full ref, a branch name, a tag name (peeled),
 * or a commit id directly. Null when nothing matches.
 */
export function resolveRevision(
  refs: ReadonlyMap<string, string>,
  lookup: ObjectLookup,
  rev: string,
): string | null {
  const candidates = [rev, `refs/heads/${rev}`, `refs/tags/${rev}`];
  for (const name of candidates) {
    const oid = refs.get(name);
    if (oid !== undefined) {
      const peeled = peelToNonTag(oid, lookup);
      if (peeled !== null && lookup(peeled)?.type === 'commit') return peeled;
      return null;
    }
  }
  if (isOid(rev)) {
    const peeled = peelToNonTag(rev, lookup);
    if (peeled !== null && lookup(peeled)?.type === 'commit') return peeled;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// flat trees: path maps, diffs, merges
// ---------------------------------------------------------------------------------------------

/** One file in a flattened tree: its blob id and mode. */
export interface FlatEntry {
  readonly oid: string;
  readonly mode: string;
}

/** Flatten a tree object into path -> blob entries, recursing into subdirectories. */
export function flattenTree(
  treeOid: string,
  lookup: ObjectLookup,
  prefix = '',
  out: Map<string, FlatEntry> = new Map(),
): Map<string, FlatEntry> {
  const object = lookup(treeOid);
  if (object === undefined || object.type !== 'tree') throw new Error(`tree ${treeOid} is missing`);
  for (const entry of parseTree(object.data)) {
    const path = `${prefix}${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.oid, lookup, `${path}/`, out);
    else if (entry.mode === '160000') continue; // a gitlink: no content in this repository
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build nested tree objects for a path map, storing each tree through `put`; returns the root id. */
export function buildTreeFromMap(
  entries: ReadonlyMap<string, FlatEntry>,
  put: (type: GitObjectType, data: Buffer) => string,
): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of entries) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const treeEntries: TreeEntry[] = [];
    for (const [name, file] of node.files) treeEntries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) treeEntries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(treeEntries));
  };
  return build(root);
}

/** Split content into lines the way git counts them: a trailing newline ends the last line. */
function contentLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Added/removed line counts between two blobs, via longest-common-subsequence on lines. */
export function diffLineCounts(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  if (oldData.equals(newData)) return { additions: 0, deletions: 0 };
  const oldLines = contentLines(oldData);
  const newLines = contentLines(newData);
  if (oldLines.length * newLines.length > 4_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  // Two-row LCS: O(min(n, m)) memory.
  let prev = new Array<number>(newLines.length + 1).fill(0);
  let curr = new Array<number>(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    for (let j = 1; j <= newLines.length; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  const common = prev[newLines.length]!;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

/** One changed file in a tree diff, in the REST pull-files shape. */
export interface FileDiff {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

/** Diff two flattened trees: every path that differs, with line counts, sorted by path. */
export function diffTrees(
  base: ReadonlyMap<string, FlatEntry>,
  head: ReadonlyMap<string, FlatEntry>,
  lookup: ObjectLookup,
): FileDiff[] {
  const paths = [...new Set([...base.keys(), ...head.keys()])].sort();
  const diffs: FileDiff[] = [];
  const blobOf = (entry: FlatEntry): Buffer => lookup(entry.oid)?.data ?? Buffer.alloc(0);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    if (b === undefined && h !== undefined) {
      const additions = contentLines(blobOf(h)).length;
      diffs.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h === undefined) {
      const deletions = contentLines(blobOf(b)).length;
      diffs.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b !== undefined && h !== undefined) {
      const { additions, deletions } = diffLineCounts(blobOf(b), blobOf(h));
      diffs.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return diffs;
}

/**
 * A three-way merge of flattened trees: `ours` and `theirs` against their `base`.
 * A path both sides changed differently is a conflict; otherwise the changed side
 * wins, and a path only one side touched keeps that side's version. Returns the
 * merged map, or null plus the conflicting paths.
 */
export function threeWayMerge(
  base: ReadonlyMap<string, FlatEntry>,
  ours: ReadonlyMap<string, FlatEntry>,
  theirs: ReadonlyMap<string, FlatEntry>,
): { merged: Map<string, FlatEntry> | null; conflicts: string[] } {
  const same = (a: FlatEntry | undefined, b: FlatEntry | undefined): boolean => {
    if (a === undefined || b === undefined) return a === b;
    return a.oid === b.oid;
  };
  const merged = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const paths = [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])].sort();
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(o, b)) {
      if (t !== undefined) merged.set(path, t);
    } else if (same(t, b)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  return { merged: conflicts.length > 0 ? null : merged, conflicts };
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

const PACK_TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Read a pack entry's type/size varint. */
function readPackEntryHeader(buffer: Buffer, start: number): { size: number; typeCode: number; next: number } {
  if (start >= buffer.length) throw new Error('pack entry has no header');
  let byte = buffer[start]!;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset]!;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, typeCode, next: offset };
}

/** Read an OFS_DELTA base offset (git's offset encoding, not a plain varint). */
function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset]!;
    offset += 1;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream starting at `offset`; returns its bytes and the offset past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset]!;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolved?: GitObject;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA
 * and REF_DELTA entries. `resolveBase` supplies a base a thin pack leaves out.
 * The trailer checksum is verified; any corruption throws.
 */
export function readPack(pack: Buffer, options: { resolveBase?: ObjectLookup } = {}): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackEntryHeader(pack, offset);
    offset = header.next;
    const entry: RawPackEntry = { offset: entryOffset, typeCode: header.typeCode, size: header.size, data: Buffer.alloc(0) };
    if (header.typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (header.typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (PACK_CODE_TYPE[header.typeCode] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${header.typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): GitObject => {
    if (entry.resolved !== undefined) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let object: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        object = { type: base.type, data: applyDelta(base.data, entry.data) };
      } else {
        const external = options.resolveBase?.(wanted);
        if (external === undefined) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        object = { type: external.type, data: applyDelta(external.data, entry.data) };
      }
    } else {
      object = { type: PACK_CODE_TYPE[entry.typeCode]!, data: entry.data };
    }
    const oid = hashObject(object.type, object.data);
    entry.resolved = object;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return object;
  };
  for (const entry of raw) {
    const object = resolve(entry);
    objects.set(hashObject(object.type, object.data), object);
  }
  return objects;
}

/** Encode one object's pack header: the type/size varint of the pack format. */
function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = PACK_TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), version 2, with a SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
