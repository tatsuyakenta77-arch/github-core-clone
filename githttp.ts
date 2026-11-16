// githttp.ts — git smart HTTP: the pkt-line framing, protocol v2 and v0
// advertisements, ls-refs, fetch (with have/want negotiation and shallow/deepen)
// and receive-pack (command lists, pack unpacking, per-ref report-status).
// Speaks the wire the suite's in-process git client speaks; no git binary involved.

import {
  collectReachable,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToNonTag,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './git.ts';
import type { Forge, Repo } from './store.ts';

/** A malformed git request: the router answers it 400 and keeps serving. */
export class GitBadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitBadRequest';
  }
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

// ---------------------------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------------------------

/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte length. */
const PKT_LINE_MAX = 65520;

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Encode one data packet: 4 hex length bytes then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new GitBadRequest('pkt-line payload is too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

/** Encode a sequence; 'flush'/'delim' are the control packets. */
export function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Decode a whole buffer into packets; throws on a malformed header or trailing bytes. */
export function parsePktStream(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new GitBadRequest('truncated pkt-line');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new GitBadRequest(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length < 4 || length > PKT_LINE_MAX) {
      throw new GitBadRequest(`invalid pkt-line length ${length}`);
    } else {
      if (offset + length > buffer.length) throw new GitBadRequest('truncated pkt-line');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** Split a receive-pack body at its first flush: the command packets, then the raw pack bytes. */
function splitAtFlush(buffer: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new GitBadRequest('truncated pkt-line in command list');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new GitBadRequest(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      return { packets, rest: buffer.subarray(offset + 4) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX) throw new GitBadRequest(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) throw new GitBadRequest('truncated pkt-line in command list');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  throw new GitBadRequest('command list has no flush packet');
}

/** Wrap bytes in sideband packets on one band, chunked under the pkt-line maximum. */
function sidebandWrap(band: 1 | 2, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const maxChunk = PKT_LINE_MAX - 4 - 1;
  for (let offset = 0; offset < data.length || parts.length === 0; offset += maxChunk) {
    const chunk = data.subarray(offset, offset + maxChunk);
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
    if (data.length === 0) break;
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

const V2_CAPABILITIES = ['ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];
const V0_UPLOAD_CAPABILITIES = 'multi_ack thin-pack side-band-64k ofs-delta shallow';
const V0_RECEIVE_CAPABILITIES = 'report-status side-band-64k delete-refs';

/** The protocol v2 capability advertisement: `version 2` plus capability lines. */
function v2Advertisement(): Buffer {
  const items: Array<string | 'flush'> = ['version 2\n'];
  for (const capability of V2_CAPABILITIES) items.push(`${capability}\n`);
  items.push('flush');
  return pktLines(items);
}

/** A protocol v0 ref advertisement with the `# service=` preamble and NUL capabilities. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const capabilities =
    service === 'git-upload-pack' ? `${symref} ${V0_UPLOAD_CAPABILITIES}` : `${V0_RECEIVE_CAPABILITIES} ${symref}`;
  const items: Array<string | 'flush'> = [`# service=${service}\n`];
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${capabilities}\n`);
  } else {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
    items.push(`${headOid} HEAD\0${capabilities}\n`);
    for (const [name, oid] of refs) {
      items.push(`${oid} ${name}\n`);
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToNonTag(oid, (id) => repo.objects.get(id));
        if (peeled !== null) items.push(`${peeled} ${name}^{}\n`);
      }
    }
  }
  items.push('flush');
  return pktLines(items);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocol: string | undefined,
): GitResponse {
  const wantsV2 = service === 'git-upload-pack' && (gitProtocol ?? '').trim() === 'version=2';
  if (wantsV2) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: v0Advertisement(repo, service),
  };
}

// ---------------------------------------------------------------------------------------------
// fetch computation: wants, haves, depth, shallow boundaries
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  /** The objects to send, each present in the store. */
  objects: GitObject[];
  /** New shallow-boundary commits the client must record. */
  shallow: string[];
  /** Formerly shallow commits whose parents are now all held. */
  unshallow: string[];
  /** The haves the server acknowledges as common. */
  acks: string[];
}

/**
 * Work out what a fetch sends. `wants` are the tips, `haves` what the client holds,
 * `depth` the generation limit (null for a full fetch), `shallowIn` the client's
 * current shallow boundary. Haves behind a shallow boundary stop the exclusion walk
 * at the boundary, so a deepen delivers exactly the next generation.
 */
function computeFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  shallowIn: readonly string[],
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const shallowInSet = new Set(shallowIn);

  // Seed commits for the breadth-first walk, plus non-commit objects wanted directly.
  const seedCommits: string[] = [];
  const direct = new Set<string>();
  for (const want of wants) {
    const object = lookup(want);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      seedCommits.push(want);
    } else if (object.type === 'tag') {
      direct.add(want);
      const peeled = peelToNonTag(want, lookup);
      if (peeled !== null) {
        if (lookup(peeled)?.type === 'commit') seedCommits.push(peeled);
        else direct.add(peeled);
      }
    } else {
      direct.add(want);
    }
  }

  // The included set: commits by generation, each with its full tree closure.
  const included = new Set<string>();
  const commitGeneration = new Map<string, number>();
  const queue: Array<{ oid: string; generation: number }> = [];
  for (const seed of seedCommits) {
    if (!commitGeneration.has(seed)) {
      commitGeneration.set(seed, 1);
      queue.push({ oid: seed, generation: 1 });
    }
  }
  const includeTreeClosure = (commitOid: string): void => {
    const commit = lookup(commitOid);
    if (commit === undefined || commit.type !== 'commit') return;
    const treeOid = parseCommit(commit.data).tree;
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (included.has(oid)) continue;
      const object = lookup(oid);
      if (object === undefined) continue;
      included.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      }
    }
  };
  while (queue.length > 0) {
    const { oid, generation } = queue.shift()!;
    if (included.has(oid)) continue;
    included.add(oid);
    includeTreeClosure(oid);
    const commit = lookup(oid);
    if (commit === undefined || commit.type !== 'commit') continue;
    const parents = parseCommit(commit.data).parents;
    const limit = depth === null ? Number.POSITIVE_INFINITY : depth;
    if (generation < limit) {
      for (const parent of parents) {
        if (!commitGeneration.has(parent)) {
          commitGeneration.set(parent, generation + 1);
          queue.push({ oid: parent, generation: generation + 1 });
        }
      }
    }
  }
  for (const oid of direct) {
    for (const reached of collectReachable([oid], lookup, { allowMissing: true })) {
      // A tag's target commit is already handled by the generation walk; never let
      // a direct object's closure smuggle history past the depth limit.
      const object = lookup(reached);
      if (object !== undefined && object.type === 'commit' && !commitGeneration.has(reached) && depth !== null) continue;
      included.add(reached);
    }
  }

  // Shallow boundary: included commits with a parent that was not included.
  const shallow: string[] = [];
  if (depth !== null) {
    for (const oid of commitGeneration.keys()) {
      const commit = lookup(oid);
      if (commit === undefined || commit.type !== 'commit') continue;
      const parents = parseCommit(commit.data).parents;
      if (parents.length > 0 && parents.some((parent) => !included.has(parent))) shallow.push(oid);
    }
  }
  shallow.sort();

  // Unshallow: a client boundary whose parents are now all included.
  const unshallow: string[] = [];
  for (const boundary of shallowIn) {
    if (!included.has(boundary)) continue;
    const commit = lookup(boundary);
    if (commit === undefined || commit.type !== 'commit') continue;
    if (parseCommit(commit.data).parents.every((parent) => included.has(parent))) unshallow.push(boundary);
  }
  unshallow.sort();

  // The exclusion walk from the haves, stopping at shallow boundaries.
  const excluded = new Set<string>();
  const walkHave = (oid: string): void => {
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (excluded.has(current)) continue;
      const object = lookup(current);
      if (object === undefined) continue;
      excluded.add(current);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        const treeStack = [commit.tree];
        while (treeStack.length > 0) {
          const treeOid = treeStack.pop()!;
          if (excluded.has(treeOid)) continue;
          const treeObject = lookup(treeOid);
          if (treeObject === undefined) continue;
          excluded.add(treeOid);
          if (treeObject.type === 'tree') {
            for (const entry of parseTree(treeObject.data)) {
              if (entry.mode !== '160000') treeStack.push(entry.oid);
            }
          }
        }
        if (shallowInSet.has(current)) continue; // the client holds nothing past its boundary
        for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      }
    }
  };
  for (const have of haves) walkHave(have);

  const send: GitObject[] = [];
  for (const oid of [...included].sort()) {
    if (excluded.has(oid)) continue;
    const object = lookup(oid);
    if (object !== undefined) send.push(object);
  }

  // Acknowledge haves that are ancestors-or-equal of a want (full closure, no depth).
  const acks: string[] = [];
  if (haves.length > 0) {
    const fullWantClosure = collectReachable(wants, lookup, { allowMissing: true });
    for (const have of haves) {
      const peeled = peelToNonTag(have, lookup);
      if ((peeled !== null && fullWantClosure.has(peeled)) || fullWantClosure.has(have)) acks.push(have);
    }
  }

  return { objects: send, shallow, unshallow, acks };
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const lines: Array<string | 'flush'> = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (keep('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${args.symrefs ? ` symref-target:${headTarget}` : ''}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${headTarget}` : ''}\n`);
    }
  }
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, oid] of refs) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToNonTag(oid, lookup);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return pktLines(lines);
}

// ---------------------------------------------------------------------------------------------
// upload-pack: v2 commands and the v0 fetch
// ---------------------------------------------------------------------------------------------

function textLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0]!;
      if (isOid(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  return { wants, haves, shallow, depth };
}

function fetchV2Response(repo: Repo, args: FetchArgs): Buffer {
  const plan = computeFetch(repo, args.wants, args.haves, args.depth, args.shallow);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  const ackItems: Array<string | 'delim'> = ['acknowledgments\n'];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) ackItems.push(`ACK ${ack}\n`);
  } else {
    ackItems.push('NAK\n');
  }
  ackItems.push('delim');
  parts.push(pktLines(ackItems));
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const shallowItems: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of plan.shallow) shallowItems.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) shallowItems.push(`unshallow ${oid}\n`);
    shallowItems.push('delim');
    parts.push(pktLines(shallowItems));
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandWrap(1, pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, args: FetchArgs): Buffer {
  const plan = computeFetch(repo, args.wants, args.haves, args.depth, args.shallow);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  const text: string[] = [];
  for (const oid of plan.shallow) text.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) text.push(`unshallow ${oid}\n`);
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) text.push(`ACK ${ack}\n`);
  } else {
    text.push('NAK\n');
  }
  if (text.length > 0) parts.push(pktLines(text));
  parts.push(sidebandWrap(1, pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack: v2 ls-refs/fetch, or the v0 fetch. */
export function handleUploadPack(
  repo: Repo,
  body: Buffer,
  gitProtocol: string | undefined,
): GitResponse {
  const packets = parsePktStream(body);
  const lines = textLines(packets);
  const first = (lines[0] ?? '').replace(/\n$/, '');
  const isV2 = (gitProtocol ?? '').trim() === 'version=2' || first.startsWith('command=');
  if (isV2) {
    if (!first.startsWith('command=')) throw new GitBadRequest('a v2 request names no command');
    const command = first.slice('command='.length).trim();
    const args = lines.slice(1);
    if (command === 'ls-refs') {
      const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const raw of args) {
        const line = raw.replace(/\n$/, '');
        if (line === 'peel') lsArgs.peel = true;
        else if (line === 'symrefs') lsArgs.symrefs = true;
        else if (line === 'unborn') lsArgs.unborn = true;
        else if (line.startsWith('ref-prefix ')) lsArgs.prefixes.push(line.slice('ref-prefix '.length));
      }
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-result',
        body: lsRefsResponse(repo, lsArgs),
      };
    }
    if (command === 'fetch') {
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-result',
        body: fetchV2Response(repo, parseFetchArgs(args)),
      };
    }
    throw new GitBadRequest(`unknown v2 command ${JSON.stringify(command)}`);
  }
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: fetchV0Response(repo, parseFetchArgs(lines)),
  };
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Apply one push command: create, fast-forward update, or delete. Refusals name their reason. */
function applyPushCommand(repo: Repo, command: PushCommand): { ok: true } | { ok: false; reason: string } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(command.ref);
    return { ok: true };
  }
  if (!repo.objects.has(command.newOid)) return { ok: false, reason: 'object not found' };
  if (command.ref.startsWith('refs/heads/')) {
    const peeled = peelToNonTag(command.newOid, lookup);
    if (peeled === null || lookup(peeled)?.type !== 'commit') return { ok: false, reason: 'not a commit' };
  }
  if (current === undefined) {
    if (command.oldOid !== ZERO_OID) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.set(command.ref, command.newOid);
    return { ok: true };
  }
  if (command.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
  if (command.newOid === current) return { ok: true };
  if (!isAncestor(current, command.newOid, lookup)) return { ok: false, reason: 'non-fast-forward' };
  repo.refs.set(command.ref, command.newOid);
  return { ok: true };
}

/** POST /{owner}/{repo}.git/git-receive-pack: unpack the pack, apply the commands, report per ref. */
export function handleReceivePack(repo: Repo, body: Buffer): GitResponse {
  const { packets, rest } = splitAtFlush(body);
  const commands: PushCommand[] = [];
  const capabilities: string[] = [];
  let firstLine = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    if (firstLine) {
      firstLine = false;
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        capabilities.push(...text.slice(nul + 1).trim().split(/\s+/).filter(Boolean));
        text = text.slice(0, nul);
      }
    }
    const line = text.replace(/\n$/, '');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match === null) throw new GitBadRequest(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  if (commands.length === 0) throw new GitBadRequest('a push names no commands');

  let unpackOk = true;
  if (rest.length > 0) {
    try {
      const unpacked = readPack(rest, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of unpacked) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
    }
  }

  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : 'unpack unpacker error\n'];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const verdict = applyPushCommand(repo, command);
    reportLines.push(verdict.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${verdict.reason}\n`);
  }
  const reportStream = pktLines([...reportLines, 'flush']);
  const useSideband = capabilities.includes('side-band-64k');
  const responseBody = useSideband
    ? Buffer.concat([sidebandWrap(1, reportStream), FLUSH])
    : reportStream;
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}

/** The forge argument, kept for the handlers' future use (quota, logging). Kept explicit. */
export type ForgeHandle = Forge;
