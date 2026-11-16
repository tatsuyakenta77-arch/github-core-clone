// rest.ts — the REST v3 surface: repositories, branches, commits, contents,
// labels, issues, comments, and pull requests, in GitHub's shapes and statuses.
// Every handler answers JSON; every error carries a string `message`.

import { Forge, isoSec, type Issue, type LabelRec, type PullRequest, type Repo } from './store.ts';

/** A request-scoped view of one REST call, built by the router. */
export interface RestContext {
  /** The URL-decoded path segments below /api/v3 (['repos', owner, name, ...]). */
  segments: string[];
  /** The query string, already parsed. */
  query: URLSearchParams;
  /** The request Host header, for building absolute pagination URLs. */
  host: string;
  /** The JSON body when one was sent, else null. `undefined` means malformed JSON. */
  body: unknown;
}

export interface RestResponse {
  status: number;
  /** Omitted for 204. */
  body?: unknown;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): RestResponse => ({
  status,
  body,
  headers,
});
const error = (status: number, message: string): RestResponse => json(status, { message });
const noContent = (): RestResponse => ({ status: 204 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: unknown, field: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function booleanField(body: unknown, field: string): boolean | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  return typeof value === 'boolean' ? value : undefined;
}

/** A stable positive id for a label, derived from its name (labels carry no counter). */
function labelId(name: string): number {
  let hash = 5381;
  for (let i = 0; i < name.length; i += 1) hash = ((hash << 5) + hash + name.charCodeAt(i)) | 0;
  return Math.abs(hash) + 1;
}

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function repoView(forge: Forge, repo: Repo): Record<string, unknown> {
  const owner = forge.viewerUser();
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${owner.login}/${repo.name}`,
    owner: { id: owner.id, login: owner.login },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoSec(repo.createdAt),
    updated_at: isoSec(repo.updatedAt),
    html_url: `https://github.com/${owner.login}/${repo.name}`,
  };
}

function labelView(label: LabelRec): Record<string, unknown> {
  return { id: labelId(label.name), name: label.name, color: label.color, description: label.description };
}

function issueView(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  const viewer = forge.viewerUser();
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { id: viewer.id, login: viewer.login },
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelView(label) : { id: labelId(name), name, color: '000000', description: '' };
    }),
    created_at: isoSec(issue.createdAt),
    updated_at: isoSec(issue.updatedAt),
    closed_at: issue.closedAt === null ? null : isoSec(issue.closedAt),
  };
}

function pullView(forge: Forge, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const viewer = forge.viewerUser();
  const shas = forge.pullShas(repo, pull);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt === null ? null : isoSec(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: shas.headSha, label: `${viewer.login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: shas.baseSha, label: `${viewer.login}:${pull.baseRef}` },
    user: { id: viewer.id, login: viewer.login },
    created_at: isoSec(pull.createdAt),
    updated_at: isoSec(pull.updatedAt),
    closed_at: pull.closedAt === null ? null : isoSec(pull.closedAt),
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

interface PageParams {
  page: number;
  perPage: number;
}

function pageParams(query: URLSearchParams): PageParams {
  const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  return {
    page: Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1,
    perPage: Number.isFinite(rawPerPage) ? Math.min(100, Math.max(1, rawPerPage)) : 30,
  };
}

/** Slice a list into one page and, when a next page exists, its absolute Link URL. */
function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  host: string,
  path: string,
): { pageItems: T[]; link: string | null } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const nextQuery = new URLSearchParams(query);
    nextQuery.set('page', String(page + 1));
    nextQuery.set('per_page', String(perPage));
    link = `<http://${host}${path}?${nextQuery.toString()}>; rel="next"`;
  }
  return { pageItems, link };
}

function linkHeaders(link: string | null): Record<string, string> | undefined {
  return link === null ? undefined : { link };
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

/**
 * Dispatch one REST call. The router has already checked the bearer token and
 * confirmed the body (when present) is valid JSON; `body === undefined` means
 * malformed JSON, which is a 400 on the routes that read a body.
 */
export function handleRest(forge: Forge, method: string, context: RestContext): RestResponse {
  const [first, ...rest] = context.segments;

  // GET /api/v3/ — the API root, with its OAuth-scopes header.
  if (context.segments.length === 0) {
    if (method !== 'GET') return error(404, 'Not Found');
    return json(
      200,
      {
        current_user_url: 'https://api.github.com/user',
        rate_limit_url: 'https://api.github.com/rate_limit',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  if (first === 'meta') {
    if (method !== 'GET') return error(404, 'Not Found');
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }

  if (first === 'user') return handleUser(forge, method, rest, context);
  if (first === 'repos') return handleRepos(forge, method, rest, context);
  return error(404, 'Not Found');
}

function handleUser(forge: Forge, method: string, rest: string[], context: RestContext): RestResponse {
  if (rest.length === 0) {
    if (method !== 'GET') return error(404, 'Not Found');
    const viewer = forge.viewerUser();
    return json(200, { id: viewer.id, login: viewer.login, type: 'User' });
  }
  if (rest[0] === 'repos') {
    if (method === 'GET') {
      const repos = forge.listRepos();
      const { pageItems, link } = paginate(repos, context.query, context.host, '/api/v3/user/repos');
      return json(200, pageItems.map((repo) => repoView(forge, repo)), linkHeaders(link));
    }
    if (method === 'POST') {
      if (context.body === undefined) return error(400, 'Problems parsing JSON');
      const name = stringField(context.body, 'name');
      if (name === undefined || name === '') return error(422, 'Validation Failed: name is required');
      const created = forge.createRepo(
        name,
        stringField(context.body, 'description') ?? '',
        booleanField(context.body, 'private') ?? false,
      );
      if ('error' in created) {
        return created.error === 'exists'
          ? error(422, 'name already exists on this account')
          : error(422, 'Validation Failed: name is invalid');
      }
      return json(201, repoView(forge, created.repo));
    }
    return error(404, 'Not Found');
  }
  return error(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// repositories and everything under them
// ---------------------------------------------------------------------------------------------

function handleRepos(forge: Forge, method: string, rest: string[], context: RestContext): RestResponse {
  const [owner, name, ...tail] = rest;
  if (owner === undefined || name === undefined) return error(404, 'Not Found');
  // A repository belongs to the login the token names; the same name under
  // another owner is a 404, never a 403.
  const repo = forge.findRepo(owner, name);
  if (repo === null) return error(404, 'Not Found');

  if (tail.length === 0) {
    if (method === 'GET') return json(200, repoView(forge, repo));
    if (method === 'PATCH') {
      if (context.body === undefined) return error(400, 'Problems parsing JSON');
      const description = stringField(context.body, 'description');
      if (description !== undefined) {
        repo.description = description;
        repo.updatedAt = forge.nextTime();
      }
      return json(200, repoView(forge, repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      return noContent();
    }
    return error(404, 'Not Found');
  }

  const [resource, ...sub] = tail;
  switch (resource) {
    case 'git':
      return handleGitRefs(forge, repo, method, sub, context);
    case 'branches':
      return handleBranches(forge, repo, method, sub);
    case 'commits':
      return handleCommits(forge, repo, method, context);
    case 'contents':
      return handleContents(forge, repo, method, sub, context);
    case 'labels':
      return handleLabels(forge, repo, method, context);
    case 'issues':
      return handleIssues(forge, repo, method, sub, context);
    case 'pulls':
      return handlePulls(forge, repo, method, sub, context);
    default:
      return error(404, 'Not Found');
  }
}

function handleGitRefs(forge: Forge, repo: Repo, method: string, sub: string[], context: RestContext): RestResponse {
  if (sub[0] !== 'refs') return error(404, 'Not Found');
  if (method === 'POST' && sub.length === 1) {
    if (context.body === undefined) return error(400, 'Problems parsing JSON');
    const ref = stringField(context.body, 'ref');
    const sha = stringField(context.body, 'sha');
    if (ref === undefined || sha === undefined) return error(422, 'Validation Failed: ref and sha are required');
    const created = forge.createRef(repo, ref, sha);
    if ('error' in created) return error(422, 'Validation Failed: ref already exists or sha is unknown');
    return json(201, { ref, object: { sha, type: 'commit' } });
  }
  if (method === 'GET') {
    if (sub.length === 1) {
      const refs = [...repo.refs.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
      return json(200, refs);
    }
    const refName = sub.join('/');
    const found = forge.getRef(repo, refName);
    if (found === null) return error(404, 'Not Found');
    return json(200, { ref: found.ref, object: { sha: found.sha, type: found.type } });
  }
  return error(404, 'Not Found');
}

function handleBranches(forge: Forge, repo: Repo, method: string, sub: string[]): RestResponse {
  if (method !== 'GET') return error(404, 'Not Found');
  if (sub.length === 0) {
    return json(
      200,
      forge.listBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha }, protected: false })),
    );
  }
  const branch = forge.getBranch(repo, sub.join('/'));
  if (branch === null) return error(404, 'Not Found');
  return json(200, { name: branch.name, commit: { sha: branch.sha }, protected: false });
}

function handleCommits(forge: Forge, repo: Repo, method: string, context: RestContext): RestResponse {
  if (method !== 'GET') return error(404, 'Not Found');
  const ref = context.query.get('sha') ?? undefined;
  const commits = forge.listCommits(repo, ref);
  return json(
    200,
    commits.map(({ sha, message }) => ({ sha, commit: { message }, parents: [] })),
  );
}

function handleContents(forge: Forge, repo: Repo, method: string, sub: string[], context: RestContext): RestResponse {
  const path = sub.join('/');
  if (method === 'GET') {
    const ref = context.query.get('ref') ?? undefined;
    const read = forge.readContent(repo, path, ref);
    if (read === null) return error(404, 'Not Found');
    if (read.kind === 'file') {
      return json(200, {
        type: 'file',
        encoding: 'base64',
        content: read.content.toString('base64'),
        sha: read.sha,
        size: read.size,
        name: read.name,
        path: read.path,
      });
    }
    return json(
      200,
      read.entries.map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, sha: entry.sha, size: 0 })),
    );
  }
  if (method === 'PUT') {
    if (context.body === undefined) return error(400, 'Problems parsing JSON');
    const message = stringField(context.body, 'message');
    const content = stringField(context.body, 'content');
    if (message === undefined || content === undefined) {
      return error(422, 'Validation Failed: message and content are required');
    }
    const bytes = Buffer.from(content.replace(/\s+/g, ''), 'base64');
    const result = forge.putContent(
      repo,
      path,
      bytes,
      message,
      stringField(context.body, 'branch'),
      stringField(context.body, 'sha'),
    );
    if ('error' in result) {
      return result.error === 'stale'
        ? error(409, 'sha does not match the current file')
        : error(422, 'Validation Failed: path is invalid or conflicts with an existing entry');
    }
    return json(result.status, {
      content: {
        sha: result.blobSha,
        encoding: 'base64',
        size: bytes.length,
        name: path.split('/').pop() ?? '',
        path,
      },
      commit: { sha: result.commitSha, message },
    });
  }
  if (method === 'DELETE') {
    if (context.body === undefined) return error(400, 'Problems parsing JSON');
    const message = stringField(context.body, 'message');
    const sha = stringField(context.body, 'sha');
    if (message === undefined || sha === undefined) {
      return error(422, 'Validation Failed: message and sha are required');
    }
    const result = forge.deleteContent(repo, path, message, sha, stringField(context.body, 'branch'));
    if ('error' in result) {
      if (result.error === 'not-found') return error(404, 'Not Found');
      if (result.error === 'stale') return error(409, 'sha does not match the current file');
      return error(422, 'Validation Failed: path is invalid');
    }
    return json(200, { commit: { sha: result.commitSha, message } });
  }
  return error(404, 'Not Found');
}

function handleLabels(forge: Forge, repo: Repo, method: string, context: RestContext): RestResponse {
  if (method === 'GET') {
    return json(200, [...repo.labels.values()].map(labelView));
  }
  if (method === 'POST') {
    if (context.body === undefined) return error(400, 'Problems parsing JSON');
    const name = stringField(context.body, 'name');
    if (name === undefined || name === '') return error(422, 'Validation Failed: name is required');
    const created = forge.createLabel(
      repo,
      name,
      stringField(context.body, 'color') ?? '000000',
      stringField(context.body, 'description') ?? '',
    );
    if ('error' in created) return error(422, 'Validation Failed: label already exists');
    return json(201, labelView(created.label));
  }
  return error(404, 'Not Found');
}

function handleIssues(forge: Forge, repo: Repo, method: string, sub: string[], context: RestContext): RestResponse {
  if (sub.length === 0) {
    if (method === 'GET') {
      const state = context.query.get('state') ?? 'open';
      const direction = context.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      if (direction === 'desc') issues.reverse();
      const { pageItems, link } = paginate(
        issues,
        context.query,
        context.host,
        `/api/v3/repos/${forge.viewerLogin()}/${repo.name}/issues`,
      );
      return json(200, pageItems.map((issue) => issueView(forge, repo, issue)), linkHeaders(link));
    }
    if (method === 'POST') {
      if (context.body === undefined) return error(400, 'Problems parsing JSON');
      const title = stringField(context.body, 'title');
      if (title === undefined || title === '') return error(422, 'Validation Failed: title is required');
      const labels = Array.isArray(context.body.labels)
        ? context.body.labels.filter((label): label is string => typeof label === 'string')
        : [];
      const created = forge.createIssue(repo, title, stringField(context.body, 'body') ?? '', labels);
      if ('error' in created) return error(422, `Validation Failed: label "${created.label}" does not exist`);
      return json(201, issueView(forge, repo, created.issue));
    }
    return error(404, 'Not Found');
  }

  const number = Number.parseInt(sub[0]!, 10);
  if (!Number.isInteger(number) || number < 1) return error(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (issue === undefined) return error(404, 'Not Found');

  if (sub.length === 1) {
    if (method === 'GET') return json(200, issueView(forge, repo, issue));
    if (method === 'PATCH') {
      if (context.body === undefined) return error(400, 'Problems parsing JSON');
      const state = stringField(context.body, 'state');
      const title = stringField(context.body, 'title');
      const body = stringField(context.body, 'body');
      if (state === 'closed' || state === 'open') {
        issue.state = state;
        issue.closedAt = state === 'closed' ? forge.nextTime() : null;
      }
      if (title !== undefined) issue.title = title;
      if (body !== undefined) issue.body = body;
      issue.updatedAt = forge.nextTime();
      return json(200, issueView(forge, repo, issue));
    }
    return error(404, 'Not Found');
  }

  if (sub[1] === 'comments') {
    const viewer = forge.viewerUser();
    if (method === 'GET') {
      return json(
        200,
        (repo.comments.get(number) ?? []).map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { id: viewer.id, login: viewer.login },
          created_at: isoSec(comment.createdAt),
          updated_at: isoSec(comment.updatedAt),
        })),
      );
    }
    if (method === 'POST') {
      if (context.body === undefined) return error(400, 'Problems parsing JSON');
      const bodyText = stringField(context.body, 'body');
      if (bodyText === undefined) return error(422, 'Validation Failed: body is required');
      const comment = forge.addComment(repo, number, bodyText);
      return json(201, {
        id: comment.id,
        body: comment.body,
        user: { id: viewer.id, login: viewer.login },
        created_at: isoSec(comment.createdAt),
        updated_at: isoSec(comment.updatedAt),
      });
    }
    return error(404, 'Not Found');
  }
  return error(404, 'Not Found');
}

function handlePulls(forge: Forge, repo: Repo, method: string, sub: string[], context: RestContext): RestResponse {
  if (sub.length === 0) {
    if (method === 'GET') {
      const state = context.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') {
        const wanted = state === 'closed' ? 'closed' : 'open';
        pulls = pulls.filter((pull) => pull.state === wanted);
      }
      pulls.sort((a, b) => b.number - a.number);
      const { pageItems, link } = paginate(
        pulls,
        context.query,
        context.host,
        `/api/v3/repos/${forge.viewerLogin()}/${repo.name}/pulls`,
      );
      return json(200, pageItems.map((pull) => pullView(forge, repo, pull)), linkHeaders(link));
    }
    if (method === 'POST') {
      if (context.body === undefined) return error(400, 'Problems parsing JSON');
      const title = stringField(context.body, 'title');
      const head = stringField(context.body, 'head');
      const base = stringField(context.body, 'base');
      if (title === undefined || head === undefined || base === undefined) {
        return error(422, 'Validation Failed: title, head, and base are required');
      }
      const created = forge.createPull(repo, title, stringField(context.body, 'body') ?? '', head, base);
      if ('error' in created) return error(422, 'Validation Failed: head or base branch does not exist');
      return json(201, pullView(forge, repo, created.pull));
    }
    return error(404, 'Not Found');
  }

  const number = Number.parseInt(sub[0]!, 10);
  if (!Number.isInteger(number) || number < 1) return error(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (pull === undefined) return error(404, 'Not Found');

  if (sub.length === 1) {
    if (method === 'GET') return json(200, pullView(forge, repo, pull));
    if (method === 'PATCH') {
      if (context.body === undefined) return error(400, 'Problems parsing JSON');
      if (stringField(context.body, 'state') === 'closed' && pull.state === 'open') {
        pull.state = 'closed';
        pull.closedAt = forge.nextTime();
        pull.updatedAt = forge.nextTime();
      }
      return json(200, pullView(forge, repo, pull));
    }
    return error(404, 'Not Found');
  }

  if (sub[1] === 'files' && method === 'GET') {
    return json(200, forge.pullFiles(repo, pull));
  }
  if (sub[1] === 'merge' && method === 'PUT') {
    if (context.body === undefined) return error(400, 'Problems parsing JSON');
    const methodField = stringField(context.body, 'merge_method') ?? 'merge';
    const outcome = forge.mergePull(repo, pull, methodField);
    if ('error' in outcome) {
      if (outcome.error === 'conflict') {
        return error(405, 'Merge conflict: the head and base branches both changed the same files');
      }
      if (outcome.error === 'closed') return error(405, 'Pull request is already closed');
      if (outcome.error === 'missing-ref') return error(404, 'Not Found');
      return error(422, 'Validation Failed: merge_method is invalid');
    }
    return json(200, {
      sha: outcome.sha,
      merged: true,
      message: `Pull Request successfully merged: ${pull.title}`,
    });
  }
  return error(404, 'Not Found');
}
