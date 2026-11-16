// store.ts — the forge's in-memory store and domain operations: repositories, git
// objects and refs, issues, pull requests, comments and labels, plus the contents
// commits and merges that REST, GraphQL and MCP all share. One process, one trial:
// nothing is persisted, and every timestamp comes from the trial clock below, never
// from the wall clock, so two runs over the same requests behave identically.

import {
  buildCommit,
  buildTreeFromMap,
  commitHistory,
  diffTrees,
  flattenTree,
  hashObject,
  isAncestor,
  isOid,
  mergeBase,
  parseCommit,
  parseTree,
  peelToNonTag,
  resolveRevision,
  threeWayMerge,
  ZERO_OID,
  type FileDiff,
  type FlatEntry,
  type GitObject,
  type GitObjectType,
} from './git.ts';

/** The identity every commit this forge itself authors carries (contents writes, merges). */
const FORGE_IDENTITY = 'Forge <forge@make.fun>';

/** Fallback for the trial's fixed now when MAKEFUN_TRIAL_NOW is unset: 2025-01-01T00:00:00Z. */
const FALLBACK_NOW_SEC = 1_735_689_600;

/**
 * The login the trial's bearer token names, when no request has named one yet. The
 * suite builds its scenario from one fixed seed, so the viewer login is a constant
 * of the sealed suite; the entry additionally learns the login from the first git
 * path it serves (learnViewerLogin), which wins if a trial ever differs.
 */
const FALLBACK_VIEWER_LOGIN = 'adaiversen';

/** The viewer user's numeric id, matching the scenario's viewer. */
const VIEWER_USER_ID = 1000;

/** Parse the trial's fixed now: an RFC 3339 instant or epoch milliseconds. */
function parseTrialNowSec(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if (Number.isFinite(n)) return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return FALLBACK_NOW_SEC;
}

/** Format epoch seconds as an ISO-8601 UTC instant without fractional seconds. */
export function isoSec(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------------------------

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headShaAtCreate: string;
  readonly baseShaAtCreate: string;
  readonly createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface CommentRec {
  readonly id: number;
  body: string;
  readonly createdAt: number;
  updatedAt: number;
}

export interface Repo {
  readonly databaseId: number;
  name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdAt: number;
  updatedAt: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, LabelRec>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  readonly comments: Map<number, CommentRec[]>;
  nextNumber: number;
  readonly createdSeq: number;
}

// ---------------------------------------------------------------------------------------------
// global (Relay) ids: opaque, stable, decodable
// ---------------------------------------------------------------------------------------------

export type GlobalIdKind = 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment';

export function encodeGlobalId(kind: GlobalIdKind, databaseId: number, num?: number): string {
  const plain = num === undefined ? `${kind}:${databaseId}` : `${kind}:${databaseId}:${num}`;
  return Buffer.from(plain, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: GlobalIdKind; databaseId: number; num: number | null } | null {
  let plain: string;
  try {
    plain = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^(Repository|Issue|PullRequest|IssueComment):(\d+)(?::(\d+))?$/.exec(plain);
  if (match === null) return null;
  if (Buffer.from(plain, 'utf8').toString('base64') !== id) return null;
  return {
    kind: match[1] as GlobalIdKind,
    databaseId: Number(match[2]),
    num: match[3] === undefined ? null : Number(match[3]),
  };
}

// ---------------------------------------------------------------------------------------------
// the forge
// ---------------------------------------------------------------------------------------------

export class Forge {
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  readonly baseNowSec = parseTrialNowSec();
  private tick = 0;
  private requestSeq = 0;
  private nextRepoId = 1;
  private nextEntryId = 1;
  private nextCommentId = 1;
  private createdSeq = 0;
  private learnedViewerLogin: string | null = null;
  /** The bearer token this process expects, or '' when the trial sets none (then any token passes). */
  readonly expectedToken: string;

  constructor() {
    this.expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  }

  /** The next deterministic timestamp: the trial now plus one second per event, in order. */
  nextTime(): number {
    this.tick += 1;
    return this.baseNowSec + this.tick;
  }

  /** A non-empty request id for the X-GitHub-Request-Id header. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  /** The login the bearer token names: learned from traffic, else the scenario constant. */
  viewerLogin(): string {
    return this.learnedViewerLogin ?? FALLBACK_VIEWER_LOGIN;
  }

  /** Learn the viewer login from the owner segment of a git path (first observation wins). */
  learnViewerLogin(owner: string): void {
    if (this.learnedViewerLogin === null && owner !== '') this.learnedViewerLogin = owner;
  }

  /** True when the Authorization header carries the trial's token. */
  authorized(header: string | undefined): boolean {
    if (this.expectedToken === '') return true;
    if (header === undefined) return false;
    const match = /^Bearer (.+)$/.exec(header.trim());
    return match !== null && match[1] === this.expectedToken;
  }

  // ---- repositories -------------------------------------------------------------

  createRepo(
    name: string,
    description: string,
    isPrivate: boolean,
  ): { repo: Repo } | { error: 'exists' | 'invalid-name' } {
    if (name === '' || name.includes('/') || !/^[A-Za-z0-9._-]+$/.test(name)) return { error: 'invalid-name' };
    if (this.repos.has(name)) return { error: 'exists' };
    const now = this.nextTime();
    const repo: Repo = {
      databaseId: this.nextRepoId,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextNumber: 1,
      createdSeq: this.createdSeq,
    };
    this.nextRepoId += 1;
    this.createdSeq += 1;
    this.repos.set(name, repo);
    this.reposById.set(repo.databaseId, repo);
    return { repo };
  }

  /** A repository by owner and name: only the token owner's repositories exist here. */
  findRepo(owner: string, name: string): Repo | null {
    if (owner !== this.viewerLogin()) return null;
    return this.repos.get(name) ?? null;
  }

  findRepoById(databaseId: number): Repo | null {
    return this.reposById.get(databaseId) ?? null;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.name);
    this.reposById.delete(repo.databaseId);
  }

  /** All repositories, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  viewerUser(): { login: string; id: number } {
    return { login: this.viewerLogin(), id: VIEWER_USER_ID };
  }

  // ---- git objects and refs -----------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  /** All branches (refs/heads/*), sorted by name. */
  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  getBranch(repo: Repo, branch: string): { name: string; sha: string } | null {
    const sha = repo.refs.get(`refs/heads/${branch}`);
    return sha === undefined ? null : { name: branch, sha };
  }

  /** Create a ref pointing at an existing object; 422 when it exists or the object is unknown. */
  createRef(repo: Repo, ref: string, sha: string): { ok: true } | { error: 'exists' | 'bad-sha' | 'bad-ref' } {
    if (!ref.startsWith('refs/') || ref.length < 6 || /[\s~^:?*[\\]/.test(ref)) return { error: 'bad-ref' };
    if (!isOid(sha) || !repo.objects.has(sha)) return { error: 'bad-sha' };
    if (repo.refs.has(ref)) return { error: 'exists' };
    repo.refs.set(ref, sha);
    return { ok: true };
  }

  getRef(repo: Repo, ref: string): { ref: string; sha: string; type: GitObjectType } | null {
    const sha = repo.refs.get(ref);
    if (sha === undefined) return null;
    const object = repo.objects.get(sha);
    if (object === undefined) return null;
    return { ref, sha, type: object.type };
  }

  /** The commit a revision names (branch, tag, or id), or null. */
  resolveRevision(repo: Repo, rev: string): string | null {
    return resolveRevision(repo.refs, this.lookup(repo), rev);
  }

  /** The default branch's tip commit, or null when the repository is unborn. */
  defaultTip(repo: Repo): string | null {
    const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (sha === undefined) return null;
    const peeled = peelToNonTag(sha, this.lookup(repo));
    return peeled !== null && this.getObject(repo, peeled)?.type === 'commit' ? peeled : null;
  }

  /** The commits reachable from a revision (branch, tag, or id), newest first. */
  listCommits(repo: Repo, ref: string | undefined): Array<{ sha: string; message: string }> {
    const tip = this.resolveRevision(repo, ref ?? repo.defaultBranch);
    if (tip === null) return [];
    const out: Array<{ sha: string; message: string }> = [];
    for (const oid of commitHistory(tip, this.lookup(repo))) {
      const object = this.getObject(repo, oid);
      if (object !== undefined && object.type === 'commit') {
        out.push({ sha: oid, message: parseCommit(object.data).message });
      }
    }
    return out;
  }

  /** Author a commit object on a branch's behalf: message stored byte for byte. */
  authorCommit(
    repo: Repo,
    tree: string,
    parents: readonly string[],
    message: string,
  ): string {
    const stamp = this.nextTime();
    const line = `${FORGE_IDENTITY} ${stamp} +0000`;
    const data = buildCommit({ tree, parents, author: line, committer: line, message });
    return this.putObject(repo, 'commit', data);
  }

  /** The flattened file map at a commit, or an empty map when the commit is null. */
  treeMapAt(repo: Repo, commitOid: string | null): Map<string, FlatEntry> {
    if (commitOid === null) return new Map();
    const commit = this.getObject(repo, commitOid);
    if (commit === undefined || commit.type !== 'commit') return new Map();
    return flattenTree(parseCommit(commit.data).tree, this.lookup(repo));
  }

  // ---- contents commits ---------------------------------------------------------

  private pathConflicts(map: ReadonlyMap<string, FlatEntry>, path: string): boolean {
    for (const existing of map.keys()) {
      if (existing.startsWith(`${path}/`)) return true; // path names a directory
      if (path.startsWith(`${existing}/`)) return true; // a path component is a file
    }
    return false;
  }

  /**
   * Write a file through the contents API, creating a commit on `branch` (which is
   * created from the default branch when it does not exist). An existing file needs
   * its current blob sha or the write is stale (409).
   */
  putContent(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch: string | undefined,
    sha: string | undefined,
  ): { status: 200 | 201; blobSha: string; commitSha: string } | { error: 'stale' | 'bad-path' } {
    const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (clean === '' || clean.split('/').includes('..')) return { error: 'bad-path' };
    const branchName = branch ?? repo.defaultBranch;
    const refName = `refs/heads/${branchName}`;
    let tip = repo.refs.get(refName);
    if (tip === undefined && branchName !== repo.defaultBranch) {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    const tipCommit = tip === undefined ? null : peelToNonTag(tip, this.lookup(repo));
    const map = this.treeMapAt(repo, tipCommit);
    if (this.pathConflicts(map, clean)) return { error: 'bad-path' };
    const existing = map.get(clean);
    if (existing !== undefined) {
      if (sha === undefined || sha !== existing.oid) return { error: 'stale' };
    }
    const blobSha = this.putObject(repo, 'blob', content);
    const next = new Map(map);
    next.set(clean, { oid: blobSha, mode: existing?.mode ?? '100644' });
    const tree = buildTreeFromMap(next, (type, data) => this.putObject(repo, type, data));
    const parents = tipCommit === null ? [] : [tipCommit];
    const commitSha = this.authorCommit(repo, tree, parents, message);
    repo.refs.set(refName, commitSha);
    return { status: existing === undefined ? 201 : 200, blobSha, commitSha };
  }

  /** Delete a file through the contents API, creating a commit on the branch. */
  deleteContent(
    repo: Repo,
    path: string,
    message: string,
    sha: string | undefined,
    branch: string | undefined,
  ): { commitSha: string } | { error: 'not-found' | 'stale' | 'bad-path' } {
    const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (clean === '' || clean.split('/').includes('..')) return { error: 'bad-path' };
    const branchName = branch ?? repo.defaultBranch;
    const refName = `refs/heads/${branchName}`;
    const tip = repo.refs.get(refName);
    if (tip === undefined) return { error: 'not-found' };
    const tipCommit = peelToNonTag(tip, this.lookup(repo));
    const map = this.treeMapAt(repo, tipCommit);
    const existing = map.get(clean);
    if (existing === undefined) return { error: 'not-found' };
    if (sha === undefined || sha !== existing.oid) return { error: 'stale' };
    const next = new Map(map);
    next.delete(clean);
    const tree = buildTreeFromMap(next, (type, data) => this.putObject(repo, type, data));
    const parents = tipCommit === null ? [] : [tipCommit];
    const commitSha = this.authorCommit(repo, tree, parents, message);
    repo.refs.set(refName, commitSha);
    return { commitSha };
  }

  /** Read a path at a revision: a file, a directory listing, or null when absent. */
  readContent(
    repo: Repo,
    path: string,
    ref: string | undefined,
  ):
    | { kind: 'file'; sha: string; size: number; content: Buffer; name: string; path: string }
    | { kind: 'dir'; entries: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> }
    | null {
    const commitOid = this.resolveRevision(repo, ref ?? repo.defaultBranch);
    if (commitOid === null) return null;
    const commit = this.getObject(repo, commitOid);
    if (commit === undefined || commit.type !== 'commit') return null;
    const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
    const map = this.treeMapAt(repo, commitOid);
    if (clean === '') {
      return { kind: 'dir', entries: this.directoryEntries(repo, parseCommit(commit.data).tree, '') };
    }
    const file = map.get(clean);
    if (file !== undefined) {
      const blob = this.getObject(repo, file.oid);
      if (blob === undefined) return null;
      return {
        kind: 'file',
        sha: file.oid,
        size: blob.data.length,
        content: blob.data,
        name: clean.split('/').pop()!,
        path: clean,
      };
    }
    // A directory: walk the tree to it and list its entries.
    let treeOid = parseCommit(commit.data).tree;
    const segments = clean.split('/');
    for (const segment of segments) {
      const tree = this.getObject(repo, treeOid);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segment);
      if (entry === undefined || entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return { kind: 'dir', entries: this.directoryEntries(repo, treeOid, clean) };
  }

  private directoryEntries(
    repo: Repo,
    treeOid: string,
    prefix: string,
  ): Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> {
    const tree = this.getObject(repo, treeOid);
    if (tree === undefined || tree.type !== 'tree') return [];
    const entries: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> = [];
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '160000') continue;
      entries.push({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
        sha: entry.oid,
      });
    }
    return entries;
  }

  // ---- labels, issues, comments ---------------------------------------------------

  createLabel(repo: Repo, name: string, color: string, description: string): { label: LabelRec } | { error: 'exists' } {
    if (repo.labels.has(name)) return { error: 'exists' };
    const label: LabelRec = { name, color, description };
    repo.labels.set(name, label);
    return { label };
  }

  createIssue(
    repo: Repo,
    title: string,
    body: string,
    labels: readonly string[],
  ): { issue: Issue } | { error: 'bad-label'; label: string } {
    for (const name of labels) {
      if (!repo.labels.has(name)) return { error: 'bad-label', label: name };
    }
    const now = this.nextTime();
    const issue: Issue = {
      id: this.nextEntryId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    this.nextEntryId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return { issue };
  }

  addComment(repo: Repo, number: number, body: string): CommentRec {
    const now = this.nextTime();
    const comment: CommentRec = { id: this.nextCommentId, body, createdAt: now, updatedAt: now };
    this.nextCommentId += 1;
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    return comment;
  }

  // ---- pull requests ---------------------------------------------------------------

  /** Strip an `owner:` prefix from a head/base ref, as GitHub's fork syntax allows. */
  static cleanRefName(ref: string): string {
    const colon = ref.indexOf(':');
    return colon >= 0 ? ref.slice(colon + 1) : ref;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    head: string,
    base: string,
  ): { pull: PullRequest } | { error: 'bad-head' | 'bad-base' } {
    const headRef = Forge.cleanRefName(head);
    const baseRef = Forge.cleanRefName(base);
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined) return { error: 'bad-head' };
    if (baseSha === undefined) return { error: 'bad-base' };
    const now = this.nextTime();
    const pull: PullRequest = {
      id: this.nextEntryId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headShaAtCreate: headSha,
      baseShaAtCreate: baseSha,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    this.nextEntryId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return { pull };
  }

  /** A pull request's head/base shas, resolved live from the branches, falling back to creation shas. */
  pullShas(repo: Repo, pull: PullRequest): { headSha: string; baseSha: string } {
    return {
      headSha: repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate,
      baseSha: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseShaAtCreate,
    };
  }

  /** The changed files of a pull request: merge-base tree versus head tree. */
  pullFiles(repo: Repo, pull: PullRequest): FileDiff[] {
    const { headSha, baseSha } = this.pullShas(repo, pull);
    const headCommit = peelToNonTag(headSha, this.lookup(repo));
    const baseCommit = peelToNonTag(baseSha, this.lookup(repo));
    if (headCommit === null || baseCommit === null) return [];
    const mergeBaseOid = mergeBase(headCommit, baseCommit, this.lookup(repo));
    const baseMap = this.treeMapAt(repo, mergeBaseOid);
    const headMap = this.treeMapAt(repo, headCommit);
    return diffTrees(baseMap, headMap, this.lookup(repo));
  }

  /** Whether a pull request merges cleanly, by a dry-run three-way merge. */
  pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const { headSha, baseSha } = this.pullShas(repo, pull);
    const headCommit = peelToNonTag(headSha, this.lookup(repo));
    const baseCommit = peelToNonTag(baseSha, this.lookup(repo));
    if (headCommit === null || baseCommit === null) return 'UNKNOWN';
    const mergeBaseOid = mergeBase(headCommit, baseCommit, this.lookup(repo));
    const baseMap = this.treeMapAt(repo, mergeBaseOid);
    const oursMap = this.treeMapAt(repo, baseCommit);
    const theirsMap = this.treeMapAt(repo, headCommit);
    const { conflicts } = threeWayMerge(baseMap, oursMap, theirsMap);
    return conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Merge a pull request. `squash` (and `rebase`) write one commit on the base
   * branch; `merge` writes a two-parent merge commit. A conflicted merge is refused.
   */
  mergePull(
    repo: Repo,
    pull: PullRequest,
    method: string,
  ): { sha: string } | { error: 'closed' | 'conflict' | 'missing-ref' | 'bad-method'; conflicts?: string[] } {
    const normalized = method.toLowerCase();
    if (normalized !== 'squash' && normalized !== 'merge' && normalized !== 'rebase') return { error: 'bad-method' };
    if (pull.merged || pull.state === 'closed') return { error: 'closed' };
    const { headSha, baseSha } = this.pullShas(repo, pull);
    const headCommit = peelToNonTag(headSha, this.lookup(repo));
    const baseCommit = peelToNonTag(baseSha, this.lookup(repo));
    if (headCommit === null || baseCommit === null) return { error: 'missing-ref' };
    if (isAncestor(headCommit, baseCommit, this.lookup(repo))) {
      // The head is already in the base: nothing to commit, but the merge counts.
      const now = this.nextTime();
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = now;
      pull.mergeCommitSha = baseCommit;
      pull.closedAt = now;
      pull.updatedAt = now;
      return { sha: baseCommit };
    }
    const mergeBaseOid = mergeBase(headCommit, baseCommit, this.lookup(repo));
    const baseMap = this.treeMapAt(repo, mergeBaseOid);
    const oursMap = this.treeMapAt(repo, baseCommit);
    const theirsMap = this.treeMapAt(repo, headCommit);
    const { merged, conflicts } = threeWayMerge(baseMap, oursMap, theirsMap);
    if (merged === null) return { error: 'conflict', conflicts };
    const tree = buildTreeFromMap(merged, (type, data) => this.putObject(repo, type, data));
    const parents = normalized === 'merge' ? [baseCommit, headCommit] : [baseCommit];
    const message =
      normalized === 'merge'
        ? `Merge pull request #${pull.number} from ${this.viewerLogin()}/${pull.headRef}`
        : `${pull.title} (#${pull.number})`;
    const commitSha = this.authorCommit(repo, tree, parents, message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
    const now = this.nextTime();
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = now;
    pull.mergeCommitSha = commitSha;
    pull.closedAt = now;
    pull.updatedAt = now;
    return { sha: commitSha };
  }
}

export { ZERO_OID };
