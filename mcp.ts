// mcp.ts — the Model Context Protocol surface: JSON-RPC 2.0 over Streamable HTTP
// at POST /mcp. Serves the modern (2026-07-28) discovery handshake plus the legacy
// initialize handshake, a fixed six-tool list, and tool calls that act on the same
// Forge store as REST. No sessions, no version enforcement, plain JSON answers.

import { Forge, type Repo } from './store.ts';

export interface McpResponse {
  status: number;
  /** Omitted for 202 (notifications). */
  body?: unknown;
}

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

/**
 * The tool list, frozen: two tools/list calls answer byte-identical arrays.
 * Required arrays hold only properties the caller fills.
 */
const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type JsonRpcId = string | number | null;

function result(id: JsonRpcId, value: unknown): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id, result: value } };
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200): McpResponse {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A tool result: text content for readers, structured content for parsers. */
function toolResult(value: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

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
  };
}

function requiredString(args: Record<string, unknown>, field: string): string | null {
  const value = args[field];
  return typeof value === 'string' && value !== '' ? value : null;
}

function optionalString(args: Record<string, unknown>, field: string): string | null {
  const value = args[field];
  return typeof value === 'string' ? value : null;
}

function requiredInt(args: Record<string, unknown>, field: string): number | null {
  const value = args[field];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function findRepoArg(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = requiredString(args, 'owner');
  const repo = requiredString(args, 'repo');
  if (owner === null || repo === null) return null;
  return forge.findRepo(owner, repo);
}

/** Run one tool call; failures are isError results, never thrown errors. */
function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = requiredString(args, 'name');
      if (repoName === null) return toolFailure('create_repo requires "name"');
      const created = forge.createRepo(
        repoName,
        optionalString(args, 'description') ?? '',
        args.private === true,
      );
      if ('error' in created) {
        return toolFailure(
          created.error === 'exists' ? `name already exists on this account: ${repoName}` : `invalid name: ${repoName}`,
        );
      }
      return toolResult(repoView(forge, created.repo));
    }
    case 'get_repo': {
      const repo = findRepoArg(forge, args);
      if (repo === null) return toolFailure('get_repo requires an existing "owner" and "repo"');
      return toolResult(repoView(forge, repo));
    }
    case 'create_issue': {
      const repo = findRepoArg(forge, args);
      const title = requiredString(args, 'title');
      if (repo === null || title === null) return toolFailure('create_issue requires "owner", "repo", and "title"');
      const created = forge.createIssue(repo, title, optionalString(args, 'body') ?? '', []);
      if ('error' in created) return toolFailure(`create_issue failed: ${created.error}`);
      const issue = created.issue;
      return toolResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state });
    }
    case 'list_issues': {
      const repo = findRepoArg(forge, args);
      if (repo === null) return toolFailure('list_issues requires an existing "owner" and "repo"');
      const state = optionalString(args, 'state');
      let issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      const list = issues.map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
      }));
      return toolResult({ issues: list });
    }
    case 'create_pull_request': {
      const repo = findRepoArg(forge, args);
      const title = requiredString(args, 'title');
      const head = requiredString(args, 'head');
      const base = requiredString(args, 'base');
      if (repo === null || title === null || head === null || base === null) {
        return toolFailure('create_pull_request requires "owner", "repo", "title", "head", and "base"');
      }
      const created = forge.createPull(repo, title, optionalString(args, 'body') ?? '', head, base);
      if ('error' in created) return toolFailure(`create_pull_request failed: ${created.error}`);
      const pull = created.pull;
      return toolResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef },
        base: { ref: pull.baseRef },
      });
    }
    case 'merge_pull_request': {
      const repo = findRepoArg(forge, args);
      const number = requiredInt(args, 'pull_number');
      if (repo === null || number === null) {
        return toolFailure('merge_pull_request requires "owner", "repo", and "pull_number"');
      }
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolFailure(`no pull request #${number}`);
      const outcome = forge.mergePull(repo, pull, 'squash');
      if ('error' in outcome) return toolFailure(`merge_pull_request failed: ${outcome.error}`);
      return toolResult({ number: pull.number, merged: true, sha: outcome.sha, state: pull.state });
    }
    default:
      return toolFailure(`unknown tool: ${name}`);
  }
}

const KNOWN_TOOLS = new Set(TOOLS.map((tool) => tool.name));

/**
 * Handle POST /mcp. `body === undefined` means malformed JSON: a 400 carrying
 * the JSON-RPC parse error. Notifications (no id) answer 202 with no body.
 */
export function handleMcp(forge: Forge, body: unknown): McpResponse {
  if (body === undefined) {
    return rpcError(null, -32700, 'Parse error: the request body is not valid JSON', 400);
  }
  if (Array.isArray(body)) {
    return rpcError(null, -32600, 'Invalid Request: batch requests are not supported', 400);
  }
  if (!isRecord(body)) {
    return rpcError(null, -32600, 'Invalid Request: the body must be a JSON-RPC object', 400);
  }
  const hasId = 'id' in body && body.id !== undefined;
  const id: JsonRpcId = hasId && (typeof body.id === 'string' || typeof body.id === 'number') ? body.id : null;
  const method = typeof body.method === 'string' ? body.method : null;

  // A notification (no id) is acknowledged and never answered.
  if (!hasId) return { status: 202 };
  if (method === null) return rpcError(id, -32600, 'Invalid Request: a method name is required');

  const params = isRecord(body.params) ? body.params : {};

  switch (method) {
    case 'server/discover':
      return result(id, {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      return result(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : null;
      if (name === null) return rpcError(id, -32602, 'Invalid params: tools/call needs a tool name');
      if (!KNOWN_TOOLS.has(name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = isRecord(params.arguments) ? params.arguments : {};
      return result(id, callTool(forge, name, args));
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
