// app.ts — the HTTP server: routing, body reading, bearer auth, the request-id
// header, and a per-request error boundary. REST, GraphQL, MCP, and git smart HTTP
// all hang off this one router; nothing here knows about the trial lifecycle.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  GitBadRequest,
  handleInfoRefs,
  handleReceivePack,
  handleUploadPack,
} from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Forge } from './store.ts';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

function sendJson(
  forge: Forge,
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_CONTENT_TYPE,
    'x-github-request-id': forge.nextRequestId(),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendBuffer(
  forge: Forge,
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': forge.nextRequestId(),
  });
  res.end(body);
}

/** Read the whole request body (git packs arrive as raw bytes; APIs as JSON). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse a JSON body: null when empty, undefined when malformed, the value otherwise.
 * Only the API surfaces call this; git bodies stay raw.
 */
function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Split a raw path into decoded segments, dropping empty ones (trailing slashes). */
function splitPath(rawPath: string): string[] {
  const segments: string[] = [];
  for (const part of rawPath.split('/')) {
    if (part === '') continue;
    try {
      segments.push(decodeURIComponent(part));
    } catch {
      segments.push(part);
    }
  }
  return segments;
}

export interface App {
  server: Server;
  forge: Forge;
}

export function createApp(forge: Forge = new Forge()): App {
  const server = createServer((req, res) => {
    void handleRequest(forge, req, res).catch((err: unknown) => {
      console.error('request handler failed:', err instanceof Error ? err.message : String(err));
      if (!res.headersSent) {
        sendJson(forge, res, 500, { message: 'Internal Server Error' });
      } else {
        res.end();
      }
    });
  });
  return { server, forge };
}

async function handleRequest(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? '/';
  const question = rawUrl.indexOf('?');
  const rawPath = question >= 0 ? rawUrl.slice(0, question) : rawUrl;
  const query = new URLSearchParams(question >= 0 ? rawUrl.slice(question + 1) : '');
  const method = req.method ?? 'GET';

  // The health check takes no auth and answers before anything else.
  if (rawPath === '/healthz') {
    if (method !== 'GET') {
      sendJson(forge, res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(forge, res, 200, { ok: true });
    return;
  }

  // Every other surface requires the trial's bearer token, checked first.
  if (!forge.authorized(req.headers.authorization)) {
    sendJson(forge, res, 401, { message: 'Requires authentication' });
    return;
  }

  const segments = splitPath(rawPath);

  // REST v3: /api/v3[/...]
  if (segments[0] === 'api' && segments[1] === 'v3') {
    const raw = await readBody(req);
    const response = handleRest(forge, method, {
      segments: segments.slice(2),
      query,
      host: req.headers.host ?? '127.0.0.1',
      body: parseJsonBody(raw),
    });
    if (response.status === 204) {
      res.writeHead(204, { 'x-github-request-id': forge.nextRequestId() });
      res.end();
      return;
    }
    sendJson(forge, res, response.status, response.body ?? null, response.headers ?? {});
    return;
  }

  // GraphQL v4: POST /api/graphql
  if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
    if (method !== 'POST') {
      sendJson(forge, res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    const response = handleGraphQL(forge, parseJsonBody(raw));
    sendJson(forge, res, response.status, response.body);
    return;
  }

  // MCP: POST /mcp
  if (segments[0] === 'mcp' && segments.length === 1) {
    if (method !== 'POST') {
      sendJson(forge, res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    const response = handleMcp(forge, parseJsonBody(raw));
    if (response.status === 202) {
      res.writeHead(202, { 'x-github-request-id': forge.nextRequestId() });
      res.end();
      return;
    }
    sendJson(forge, res, response.status, response.body);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs, git-upload-pack, git-receive-pack}
  if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
    const owner = segments[0]!;
    const repoName = segments[1]!.slice(0, -'.git'.length);
    // Git paths always name the token owner, so the viewer login is learned here
    // and nowhere else: no check ever uses a foreign owner on a git path.
    forge.learnViewerLogin(owner);
    const repo = forge.findRepo(owner, repoName);
    if (repo === null) {
      sendJson(forge, res, 404, { message: 'Not Found' });
      return;
    }
    const servicePath = segments.slice(2).join('/');
    try {
      if (servicePath === 'info/refs' && method === 'GET') {
        const service = query.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(forge, res, 400, { message: 'a service parameter is required' });
          return;
        }
        const response = handleInfoRefs(repo, service, req.headers['git-protocol']);
        sendBuffer(forge, res, response.status, response.contentType, response.body);
        return;
      }
      if (servicePath === 'git-upload-pack' && method === 'POST') {
        const raw = await readBody(req);
        const response = handleUploadPack(repo, raw, req.headers['git-protocol']);
        sendBuffer(forge, res, response.status, response.contentType, response.body);
        return;
      }
      if (servicePath === 'git-receive-pack' && method === 'POST') {
        const raw = await readBody(req);
        const response = handleReceivePack(repo, raw);
        sendBuffer(forge, res, response.status, response.contentType, response.body);
        return;
      }
    } catch (err) {
      if (err instanceof GitBadRequest) {
        sendJson(forge, res, 400, { message: err.message });
        return;
      }
      throw err;
    }
    sendJson(forge, res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(forge, res, 404, { message: 'Not Found' });
}
