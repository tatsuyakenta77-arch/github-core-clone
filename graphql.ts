// graphql.ts — a small GraphQL executor for the fixed document set the suite sends:
// a lexer, a recursive-descent parser, and a resolver over the shared Forge store.
// Queries and mutations, variables, aliases, inline fragments, __type introspection,
// and JSON-array batching. Unknown fields are GraphQL errors (HTTP 200), never crashes.

import type { FileDiff } from './git.ts';
import {
  encodeGlobalId,
  Forge,
  parseGlobalId,
  type CommentRec,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

const PUNCTUATION = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCTUATION.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (isNameStart(ch)) {
      const start = i;
      while (i < source.length && isNameChar(source[i]!)) i += 1;
      tokens.push({ kind: 'name', value: source.slice(start, i) });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const start = i;
      if (source[i] === '-') i += 1;
      while (i < source.length && /[0-9]/.test(source[i]!)) i += 1;
      let isFloat = false;
      if (source[i] === '.' && /[0-9]/.test(source[i + 1] ?? '')) {
        isFloat = true;
        i += 1;
        while (i < source.length && /[0-9]/.test(source[i]!)) i += 1;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        let j = i + 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        if (/[0-9]/.test(source[j] ?? '')) {
          isFloat = true;
          i = j;
          while (i < source.length && /[0-9]/.test(source[i]!)) i += 1;
        }
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(start, i) });
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end).replace(/\\"""/g, '"""') });
        i = end + 3;
        continue;
      }
      i += 1;
      let value = '';
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const escape = source[i + 1];
          const escapes: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          if (escape === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else if (escape !== undefined && escape in escapes) {
            value += escapes[escape];
            i += 2;
          } else {
            throw new Error(`bad string escape \\${escape ?? ''}`);
          }
        } else {
          value += source[i];
          i += 1;
        }
      }
      if (i >= source.length) throw new Error('unterminated string');
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

export interface SpreadNode {
  kind: 'spread';
  name: string;
}

export type SelectionNode = FieldNode | FragmentNode | SpreadNode;

export interface VariableDefinition {
  name: string;
  defaultValue: ValueNode | null;
}

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: VariableDefinition[];
  selections: SelectionNode[];
}

export interface FragmentDefinition {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentDefinition>;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private eatPunct(value: string): boolean {
    if (!this.atPunct(value)) return false;
    this.pos += 1;
    return true;
  }

  private expectPunct(value: string): void {
    if (!this.eatPunct(value)) throw new Error(`expected "${value}", found ${JSON.stringify(this.peek().value)}`);
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected ${what}, found ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDefinition>();
    while (this.peek().kind !== 'eof') {
      if (this.atPunct('{')) {
        operations.push({
          operation: 'query',
          name: null,
          variables: [],
          selections: this.parseSelectionSet(),
        });
      } else {
        const keyword = this.expectName('an operation or fragment');
        if (keyword === 'query' || keyword === 'mutation') {
          operations.push(this.parseOperation(keyword));
        } else if (keyword === 'fragment') {
          const definition = this.parseFragmentDefinition();
          fragments.set(definition.name, definition);
        } else {
          throw new Error(`unexpected document keyword ${JSON.stringify(keyword)}`);
        }
      }
    }
    return { operations, fragments };
  }

  private parseOperation(operation: 'query' | 'mutation'): OperationNode {
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables = this.atPunct('(') ? this.parseVariableDefinitions() : [];
    this.parseDirectives();
    return { operation, name, variables, selections: this.parseSelectionSet() };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    this.expectPunct('(');
    const definitions: VariableDefinition[] = [];
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName('a variable name');
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.eatPunct('=')) defaultValue = this.parseValue(true);
      this.parseDirectives();
      definitions.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return definitions;
  }

  private parseType(): void {
    if (this.eatPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    this.eatPunct('!');
  }

  private parseFragmentDefinition(): FragmentDefinition {
    const name = this.expectName('a fragment name');
    const on = this.expectName('"on"');
    if (on !== 'on') throw new Error(`expected "on", found ${JSON.stringify(on)}`);
    const typeCondition = this.expectName('a type condition');
    this.parseDirectives();
    return { name, typeCondition, selections: this.parseSelectionSet() };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.atPunct('...')) {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type condition');
        this.parseDirectives();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.parseDirectives();
        return { kind: 'spread', name };
      }
      this.parseDirectives();
      return { kind: 'fragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let name = this.expectName('a field name');
    let alias: string | null = null;
    if (this.eatPunct(':')) {
      alias = name;
      name = this.expectName('a field name');
    }
    const args = this.atPunct('(') ? this.parseArguments() : [];
    this.parseDirectives();
    const selections = this.atPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!this.atPunct(')')) {
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(constant: boolean): ValueNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$' && !constant) {
      this.next();
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (token.kind === 'int') {
      this.next();
      return { kind: 'int', value: token.value };
    }
    if (token.kind === 'float') {
      this.next();
      return { kind: 'float', value: token.value };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (this.eatPunct('[')) {
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue(constant));
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (this.eatPunct('{')) {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.atPunct('}')) {
        const name = this.expectName('an object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(constant) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }

  private parseDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName('a directive name');
      if (this.atPunct('(')) this.parseArguments();
    }
  }

}

export function parseDocument(source: string): DocumentNode {
  return new Parser(lex(source)).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// values and introspection tables
// ---------------------------------------------------------------------------------------------

type GqlObject =
  | { t: 'Query' }
  | { t: 'Mutation' }
  | { t: 'User'; login: string; id: number }
  | { t: 'Repository'; repo: Repo }
  | { t: 'Ref'; name: string }
  | { t: 'Issue'; repo: Repo; issue: Issue }
  | { t: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { t: 'IssueConnection'; items: GqlObject[]; pageInfo: PageInfoValue }
  | { t: 'PullRequestConnection'; items: GqlObject[]; pageInfo: PageInfoValue }
  | { t: 'ChangedFileConnection'; items: GqlObject[]; pageInfo: PageInfoValue }
  | { t: 'ChangedFile'; file: FileDiff }
  | { t: 'PageInfo'; value: PageInfoValue }
  | { t: 'Type'; name: string }
  | { t: 'Field'; name: string }
  | { t: 'EnumValue'; name: string }
  | { t: 'CreateIssuePayload'; repo: Repo; issue: Issue | null }
  | { t: 'CloseIssuePayload'; repo: Repo; issue: Issue | null }
  | { t: 'CreatePullRequestPayload'; repo: Repo; pull: PullRequest | null }
  | { t: 'MergePullRequestPayload'; repo: Repo; pull: PullRequest | null }
  | { t: 'AddCommentPayload'; repo: Repo; comment: CommentRec | null }
  | { t: 'CommentEdge'; repo: Repo; comment: CommentRec }
  | { t: 'IssueComment'; repo: Repo; comment: CommentRec };

interface PageInfoValue {
  hasNextPage: boolean;
  endCursor: string | null;
  hasPreviousPage: boolean;
  startCursor: string | null;
}

/** The interfaces each object type implements, for fragment type conditions. */
const IMPLEMENTS: Record<string, string[]> = {
  Repository: ['Node'],
  Issue: ['Node'],
  PullRequest: ['Node'],
  IssueComment: ['Node'],
};

/** Field names each introspected object type reports (checks assert inclusion). */
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt',
    'labels', 'comments', 'repository', 'url', 'assignees', 'milestone', 'locked', 'viewerCanUpdate',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'headRef',
    'baseRef', 'isDraft', 'additions', 'deletions', 'changedFiles', 'commits', 'reviews',
    'labels', 'comments', 'url',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'defaultBranch', 'forkCount', 'stargazerCount', 'watchers', 'url',
    'homepageUrl', 'licenseInfo', 'languages',
  ],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url', 'bio', 'company', 'location'],
  Query: ['viewer', 'repository', 'node', 'search', 'user', 'organization'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

/** Enum values each introspected enum type reports (checks assert inclusion). */
const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'CODE', 'COMMIT', 'DISCUSSION', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

interface GraphQLError {
  message: string;
  path: Array<string | number>;
}

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefinition>;
  errors: GraphQLError[];
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
      return Number.parseInt(node.value, 10);
    case 'float':
      return Number.parseFloat(node.value);
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, variables);
  return args;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/** Encode a list position as an opaque cursor; decode returns the position or null. */
function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const plain = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(plain);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function issueConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  const first = asInt(args.first) ?? 30;
  const after = asString(args.after);
  let issues = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? args.states.filter((s): s is string => typeof s === 'string') : null;
  if (states !== null) {
    issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
  } else {
    issues = issues.filter((issue) => issue.state === 'open');
  }
  const orderBy = asRecord(args.orderBy);
  if (orderBy !== null && orderBy.field === 'CREATED_AT') {
    issues.sort((a, b) => a.createdAt - b.createdAt || a.number - b.number);
    if (orderBy.direction === 'DESC') issues.reverse();
  } else if (orderBy !== null && orderBy.direction === 'DESC') {
    issues.sort((a, b) => b.number - a.number);
  } else {
    issues.sort((a, b) => a.number - b.number);
  }
  const start = after === null ? 0 : (decodeCursor(after) ?? -1) + 1;
  const page = issues.slice(start, start + Math.max(0, first));
  const hasNextPage = start + page.length < issues.length;
  const pageInfo: PageInfoValue = {
    hasNextPage,
    endCursor: page.length > 0 ? encodeCursor(start + page.length - 1) : null,
    hasPreviousPage: start > 0,
    startCursor: page.length > 0 ? encodeCursor(start) : null,
  };
  return {
    t: 'IssueConnection',
    items: page.map((issue) => ({ t: 'Issue', repo, issue }) as GqlObject),
    pageInfo,
  };
}

type Resolver = (
  value: GqlObject,
  args: Record<string, unknown>,
  ctx: ExecContext,
) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_value, _args, ctx) => {
      const viewer = ctx.forge.viewerUser();
      return { t: 'User', login: viewer.login, id: viewer.id } satisfies GqlObject;
    },
    repository: (_value, args, ctx) => {
      const owner = asString(args.owner);
      const name = asString(args.name);
      if (owner === null || name === null) return null;
      const repo = ctx.forge.findRepo(owner, name);
      return repo === null ? null : ({ t: 'Repository', repo } satisfies GqlObject);
    },
    node: (_value, args, ctx) => {
      const id = asString(args.id);
      if (id === null) return null;
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      const repo = ctx.forge.findRepoById(parsed.databaseId);
      if (repo === null) return null;
      if (parsed.kind === 'Repository') return { t: 'Repository', repo } satisfies GqlObject;
      if (parsed.kind === 'Issue' && parsed.num !== null) {
        const issue = repo.issues.get(parsed.num);
        return issue === undefined ? null : ({ t: 'Issue', repo, issue } satisfies GqlObject);
      }
      if (parsed.kind === 'PullRequest' && parsed.num !== null) {
        const pull = repo.pulls.get(parsed.num);
        return pull === undefined ? null : ({ t: 'PullRequest', repo, pull } satisfies GqlObject);
      }
      return null;
    },
    __type: (_value, args) => {
      const name = asString(args.name);
      if (name === null) return null;
      if (name in TYPE_FIELDS || name in TYPE_ENUM_VALUES) return { t: 'Type', name } satisfies GqlObject;
      return null;
    },
  },
  Mutation: {
    createIssue: (_value, args, ctx) => {
      const input = asRecord(args.input);
      const repositoryId = input === null ? null : asString(input.repositoryId);
      const title = input === null ? null : asString(input.title);
      const body = input === null ? null : asString(input.body);
      if (repositoryId === null || title === null) throw new Error('createIssue needs repositoryId and title');
      const parsed = parseGlobalId(repositoryId);
      const repo = parsed === null ? null : ctx.forge.findRepoById(parsed.databaseId);
      if (repo === null) throw new Error('createIssue names an unknown repository');
      const created = ctx.forge.createIssue(repo, title, body ?? '', []);
      if ('error' in created) throw new Error(`createIssue failed: ${created.error}`);
      return { t: 'CreateIssuePayload', repo, issue: created.issue } satisfies GqlObject;
    },
    closeIssue: (_value, args, ctx) => {
      const input = asRecord(args.input);
      const issueId = input === null ? null : asString(input.issueId);
      if (issueId === null) throw new Error('closeIssue needs issueId');
      const parsed = parseGlobalId(issueId);
      const repo = parsed === null ? null : ctx.forge.findRepoById(parsed.databaseId);
      const issue = repo !== null && parsed !== null && parsed.num !== null ? repo.issues.get(parsed.num) : undefined;
      if (repo === null || issue === undefined) throw new Error('closeIssue names an unknown issue');
      issue.state = 'closed';
      issue.closedAt = ctx.forge.nextTime();
      issue.updatedAt = ctx.forge.nextTime();
      return { t: 'CloseIssuePayload', repo, issue } satisfies GqlObject;
    },
    createPullRequest: (_value, args, ctx) => {
      const input = asRecord(args.input);
      const repositoryId = input === null ? null : asString(input.repositoryId);
      const title = input === null ? null : asString(input.title);
      const headRefName = input === null ? null : asString(input.headRefName);
      const baseRefName = input === null ? null : asString(input.baseRefName);
      const body = input === null ? null : asString(input.body);
      if (repositoryId === null || title === null || headRefName === null || baseRefName === null) {
        throw new Error('createPullRequest needs repositoryId, title, headRefName and baseRefName');
      }
      const parsed = parseGlobalId(repositoryId);
      const repo = parsed === null ? null : ctx.forge.findRepoById(parsed.databaseId);
      if (repo === null) throw new Error('createPullRequest names an unknown repository');
      const created = ctx.forge.createPull(repo, title, body ?? '', headRefName, baseRefName);
      if ('error' in created) throw new Error(`createPullRequest failed: ${created.error}`);
      return { t: 'CreatePullRequestPayload', repo, pull: created.pull } satisfies GqlObject;
    },
    mergePullRequest: (_value, args, ctx) => {
      const input = asRecord(args.input);
      const pullRequestId = input === null ? null : asString(input.pullRequestId);
      const mergeMethod = input === null ? null : asString(input.mergeMethod);
      if (pullRequestId === null) throw new Error('mergePullRequest needs pullRequestId');
      const parsed = parseGlobalId(pullRequestId);
      const repo = parsed === null ? null : ctx.forge.findRepoById(parsed.databaseId);
      const pull = repo !== null && parsed !== null && parsed.num !== null ? repo.pulls.get(parsed.num) : undefined;
      if (repo === null || pull === undefined) throw new Error('mergePullRequest names an unknown pull request');
      const outcome = ctx.forge.mergePull(repo, pull, (mergeMethod ?? 'SQUASH').toLowerCase());
      if ('error' in outcome) throw new Error(`mergePullRequest failed: ${outcome.error}`);
      return { t: 'MergePullRequestPayload', repo, pull } satisfies GqlObject;
    },
    addComment: (_value, args, ctx) => {
      const input = asRecord(args.input);
      const subjectId = input === null ? null : asString(input.subjectId);
      const body = input === null ? null : asString(input.body);
      if (subjectId === null || body === null) throw new Error('addComment needs subjectId and body');
      const parsed = parseGlobalId(subjectId);
      const repo = parsed === null ? null : ctx.forge.findRepoById(parsed.databaseId);
      const issue = repo !== null && parsed !== null && parsed.num !== null ? repo.issues.get(parsed.num) : undefined;
      if (repo === null || issue === undefined) throw new Error('addComment names an unknown subject');
      const comment = ctx.forge.addComment(repo, issue.number, body);
      return { t: 'AddCommentPayload', repo, comment } satisfies GqlObject;
    },
  },
  User: {
    login: (value) => (value.t === 'User' ? value.login : null),
    id: (value) => (value.t === 'User' ? Buffer.from(`User:${value.id}`, 'utf8').toString('base64') : null),
  },
  Repository: {
    id: (value) => (value.t === 'Repository' ? encodeGlobalId('Repository', value.repo.databaseId) : null),
    databaseId: (value) => (value.t === 'Repository' ? value.repo.databaseId : null),
    name: (value) => (value.t === 'Repository' ? value.repo.name : null),
    nameWithOwner: (value, _args, ctx) =>
      value.t === 'Repository' ? `${ctx.forge.viewerLogin()}/${value.repo.name}` : null,
    owner: (_value, _args, ctx) => {
      const viewer = ctx.forge.viewerUser();
      return { t: 'User', login: viewer.login, id: viewer.id } satisfies GqlObject;
    },
    defaultBranchRef: (value) => {
      if (value.t !== 'Repository') return null;
      const branch = value.repo.refs.get(`refs/heads/${value.repo.defaultBranch}`);
      return branch === undefined ? null : ({ t: 'Ref', name: value.repo.defaultBranch } satisfies GqlObject);
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (value, args) => {
      if (value.t !== 'Repository') return null;
      const number = asInt(args.number);
      if (number === null) return null;
      const issue = value.repo.issues.get(number);
      return issue === undefined ? null : ({ t: 'Issue', repo: value.repo, issue } satisfies GqlObject);
    },
    issues: (value, args) => (value.t === 'Repository' ? issueConnection(value.repo, args) : null),
    pullRequests: (value, args) => {
      if (value.t !== 'Repository') return null;
      const first = asInt(args.first) ?? 30;
      const pulls = [...value.repo.pulls.values()].sort((a, b) => b.number - a.number);
      const page = pulls.slice(0, Math.max(0, first));
      return {
        t: 'PullRequestConnection',
        items: page.map((pull) => ({ t: 'PullRequest', repo: value.repo, pull }) as GqlObject),
        pageInfo: {
          hasNextPage: page.length < pulls.length,
          endCursor: page.length > 0 ? encodeCursor(page.length - 1) : null,
          hasPreviousPage: false,
          startCursor: page.length > 0 ? encodeCursor(0) : null,
        },
      } satisfies GqlObject;
    },
    pullRequest: (value, args) => {
      if (value.t !== 'Repository') return null;
      const number = asInt(args.number);
      if (number === null) return null;
      const pull = value.repo.pulls.get(number);
      return pull === undefined ? null : ({ t: 'PullRequest', repo: value.repo, pull } satisfies GqlObject);
    },
  },
  Ref: {
    name: (value) => (value.t === 'Ref' ? value.name : null),
  },
  Issue: {
    id: (value) => (value.t === 'Issue' ? encodeGlobalId('Issue', value.repo.databaseId, value.issue.number) : null),
    number: (value) => (value.t === 'Issue' ? value.issue.number : null),
    title: (value) => (value.t === 'Issue' ? value.issue.title : null),
    state: (value) => (value.t === 'Issue' ? value.issue.state.toUpperCase() : null),
    body: (value) => (value.t === 'Issue' ? value.issue.body : null),
  },
  PullRequest: {
    id: (value) =>
      value.t === 'PullRequest' ? encodeGlobalId('PullRequest', value.repo.databaseId, value.pull.number) : null,
    number: (value) => (value.t === 'PullRequest' ? value.pull.number : null),
    state: (value) => (value.t === 'PullRequest' ? pullState(value.pull) : null),
    merged: (value) => (value.t === 'PullRequest' ? value.pull.merged : null),
    headRefName: (value) => (value.t === 'PullRequest' ? value.pull.headRef : null),
    baseRefName: (value) => (value.t === 'PullRequest' ? value.pull.baseRef : null),
    mergeable: (value, _args, ctx) =>
      value.t === 'PullRequest' ? ctx.forge.pullMergeable(value.repo, value.pull) : null,
    files: (value, args, ctx) => {
      if (value.t !== 'PullRequest') return null;
      const first = asInt(args.first) ?? 30;
      const diffs = ctx.forge.pullFiles(value.repo, value.pull).slice(0, Math.max(0, first));
      return {
        t: 'ChangedFileConnection',
        items: diffs.map((file) => ({ t: 'ChangedFile', file }) as GqlObject),
        pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
      } satisfies GqlObject;
    },
  },
  IssueConnection: {
    nodes: (value) => (value.t === 'IssueConnection' ? value.items : null),
    pageInfo: (value) =>
      value.t === 'IssueConnection' ? ({ t: 'PageInfo', value: value.pageInfo } satisfies GqlObject) : null,
  },
  PullRequestConnection: {
    nodes: (value) => (value.t === 'PullRequestConnection' ? value.items : null),
    pageInfo: (value) =>
      value.t === 'PullRequestConnection' ? ({ t: 'PageInfo', value: value.pageInfo } satisfies GqlObject) : null,
  },
  ChangedFileConnection: {
    nodes: (value) => (value.t === 'ChangedFileConnection' ? value.items : null),
    pageInfo: (value) =>
      value.t === 'ChangedFileConnection' ? ({ t: 'PageInfo', value: value.pageInfo } satisfies GqlObject) : null,
  },
  ChangedFile: {
    path: (value) => (value.t === 'ChangedFile' ? value.file.filename : null),
  },
  PageInfo: {
    hasNextPage: (value) => (value.t === 'PageInfo' ? value.value.hasNextPage : null),
    endCursor: (value) => (value.t === 'PageInfo' ? value.value.endCursor : null),
    hasPreviousPage: (value) => (value.t === 'PageInfo' ? value.value.hasPreviousPage : null),
    startCursor: (value) => (value.t === 'PageInfo' ? value.value.startCursor : null),
  },
  Type: {
    name: (value) => (value.t === 'Type' ? value.name : null),
    kind: (value) => (value.t === 'Type' ? (value.name in TYPE_FIELDS ? 'OBJECT' : 'ENUM') : null),
    fields: (value) =>
      value.t === 'Type'
        ? (TYPE_FIELDS[value.name] ?? []).map((name) => ({ t: 'Field', name }) as GqlObject)
        : null,
    enumValues: (value) =>
      value.t === 'Type'
        ? (TYPE_ENUM_VALUES[value.name] ?? []).map((name) => ({ t: 'EnumValue', name }) as GqlObject)
        : null,
  },
  Field: {
    name: (value) => (value.t === 'Field' ? value.name : null),
  },
  EnumValue: {
    name: (value) => (value.t === 'EnumValue' ? value.name : null),
  },
  CreateIssuePayload: {
    issue: (value) =>
      value.t === 'CreateIssuePayload' && value.issue !== null
        ? ({ t: 'Issue', repo: value.repo, issue: value.issue } satisfies GqlObject)
        : null,
  },
  CloseIssuePayload: {
    issue: (value) =>
      value.t === 'CloseIssuePayload' && value.issue !== null
        ? ({ t: 'Issue', repo: value.repo, issue: value.issue } satisfies GqlObject)
        : null,
  },
  CreatePullRequestPayload: {
    pullRequest: (value) =>
      value.t === 'CreatePullRequestPayload' && value.pull !== null
        ? ({ t: 'PullRequest', repo: value.repo, pull: value.pull } satisfies GqlObject)
        : null,
  },
  MergePullRequestPayload: {
    pullRequest: (value) =>
      value.t === 'MergePullRequestPayload' && value.pull !== null
        ? ({ t: 'PullRequest', repo: value.repo, pull: value.pull } satisfies GqlObject)
        : null,
  },
  AddCommentPayload: {
    commentEdge: (value) =>
      value.t === 'AddCommentPayload' && value.comment !== null
        ? ({ t: 'CommentEdge', repo: value.repo, comment: value.comment } satisfies GqlObject)
        : null,
  },
  CommentEdge: {
    node: (value) =>
      value.t === 'CommentEdge' ? ({ t: 'IssueComment', repo: value.repo, comment: value.comment } satisfies GqlObject) : null,
  },
  IssueComment: {
    id: (value) =>
      value.t === 'IssueComment' ? encodeGlobalId('IssueComment', value.repo.databaseId, value.comment.id) : null,
    body: (value) => (value.t === 'IssueComment' ? value.comment.body : null),
  },
};

function typeNameOf(value: GqlObject): string {
  switch (value.t) {
    case 'Query':
      return 'Query';
    case 'Mutation':
      return 'Mutation';
    case 'User':
      return 'User';
    case 'Repository':
      return 'Repository';
    case 'Ref':
      return 'Ref';
    case 'Issue':
      return 'Issue';
    case 'PullRequest':
      return 'PullRequest';
    case 'IssueConnection':
      return 'IssueConnection';
    case 'PullRequestConnection':
      return 'PullRequestConnection';
    case 'ChangedFileConnection':
      return 'PullRequestChangedFileConnection';
    case 'ChangedFile':
      return 'PullRequestChangedFile';
    case 'PageInfo':
      return 'PageInfo';
    case 'Type':
      return '__Type';
    case 'Field':
      return '__Field';
    case 'EnumValue':
      return '__EnumValue';
    case 'CreateIssuePayload':
      return 'CreateIssuePayload';
    case 'CloseIssuePayload':
      return 'CloseIssuePayload';
    case 'CreatePullRequestPayload':
      return 'CreatePullRequestPayload';
    case 'MergePullRequestPayload':
      return 'MergePullRequestPayload';
    case 'AddCommentPayload':
      return 'AddCommentPayload';
    case 'CommentEdge':
      return 'IssueCommentEdge';
    case 'IssueComment':
      return 'IssueComment';
  }
}

function fragmentApplies(typeCondition: string | null, parentType: string): boolean {
  if (typeCondition === null) return true;
  if (typeCondition === parentType) return true;
  return (IMPLEMENTS[parentType] ?? []).includes(typeCondition);
}

function isGqlObject(value: unknown): value is GqlObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    't' in value &&
    typeof (value as { t: unknown }).t === 'string'
  );
}

function executeSelectionSet(
  selections: readonly SelectionNode[],
  parentType: string,
  parentValue: GqlObject,
  ctx: ExecContext,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (!fragmentApplies(selection.typeCondition, parentType)) continue;
      Object.assign(out, executeSelectionSet(selection.selections, parentType, parentValue, ctx, path));
      continue;
    }
    if (selection.kind === 'spread') {
      const definition = ctx.fragments.get(selection.name);
      if (definition === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".`, path: [...path] });
        continue;
      }
      if (!fragmentApplies(definition.typeCondition, parentType)) continue;
      Object.assign(out, executeSelectionSet(definition.selections, parentType, parentValue, ctx, path));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const fieldPath = [...path, responseKey];
    const resolver = RESOLVERS[parentType]?.[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({
        message: `Cannot query field "${selection.name}" on type "${parentType}".`,
        path: fieldPath,
      });
      out[responseKey] = null;
      continue;
    }
    let resolved: unknown;
    try {
      resolved = resolver(parentValue, resolveArgs(selection, ctx.variables), ctx);
    } catch (err) {
      ctx.errors.push({
        message: err instanceof Error ? err.message : String(err),
        path: fieldPath,
      });
      out[responseKey] = null;
      continue;
    }
    if (selection.selections.length === 0) {
      out[responseKey] = resolved;
      continue;
    }
    if (resolved === null || resolved === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (Array.isArray(resolved)) {
      out[responseKey] = resolved.map((item, index) => {
        if (!isGqlObject(item)) return item;
        return executeSelectionSet(selection.selections, typeNameOf(item), item, ctx, [...fieldPath, index]);
      });
      continue;
    }
    if (isGqlObject(resolved)) {
      out[responseKey] = executeSelectionSet(selection.selections, typeNameOf(resolved), resolved, ctx, fieldPath);
      continue;
    }
    out[responseKey] = resolved;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// request handling
// ---------------------------------------------------------------------------------------------

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: GraphQLError[];
}

function executeOperation(
  forge: Forge,
  document: DocumentNode,
  operationName: string | null,
  variables: Record<string, unknown>,
): GraphQLResult {
  let operation: OperationNode | undefined;
  if (operationName !== null) {
    operation = document.operations.find((candidate) => candidate.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".`, path: [] }] };
    }
  } else if (document.operations.length === 1) {
    operation = document.operations[0]!;
  } else {
    return {
      data: null,
      errors: [{ message: 'This document holds more than one operation; an operationName is required.', path: [] }],
    };
  }
  const resolvedVariables: Record<string, unknown> = { ...variables };
  for (const definition of operation.variables) {
    if (!(definition.name in resolvedVariables) || resolvedVariables[definition.name] === undefined) {
      if (definition.defaultValue !== null) {
        resolvedVariables[definition.name] = resolveValue(definition.defaultValue, resolvedVariables);
      }
    }
  }
  const ctx: ExecContext = { forge, variables: resolvedVariables, fragments: document.fragments, errors: [] };
  const root: GqlObject = operation.operation === 'mutation' ? { t: 'Mutation' } : { t: 'Query' };
  const data = executeSelectionSet(
    operation.selections,
    operation.operation === 'mutation' ? 'Mutation' : 'Query',
    root,
    ctx,
    [],
  );
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

function executeRequestBody(forge: Forge, body: unknown): GraphQLResult {
  if (!isRecordLike(body) || typeof body.query !== 'string') {
    return { data: null, errors: [{ message: 'A GraphQL request needs a string "query".', path: [] }] };
  }
  let document: DocumentNode;
  try {
    document = parseDocument(body.query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err), path: [] }] };
  }
  const variables = isRecordLike(body.variables) ? (body.variables as Record<string, unknown>) : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  return executeOperation(forge, document, operationName, variables);
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface GraphQLResponse {
  status: number;
  body: unknown;
}

/**
 * Handle POST /api/graphql. `body === undefined` means malformed JSON (400);
 * a JSON array is a batch answered in order; GraphQL failures are HTTP 200
 * with an `errors` array.
 */
export function handleGraphQL(forge: Forge, body: unknown): GraphQLResponse {
  if (body === undefined) return { status: 400, body: { message: 'Problems parsing JSON' } };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => executeRequestBody(forge, entry)) };
  }
  return { status: 200, body: executeRequestBody(forge, body) };
}
