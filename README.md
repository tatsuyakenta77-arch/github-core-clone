# REPO

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/OWNER/REPO/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/OWNER/REPO/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge: git smart-HTTP clone/fetch/push plus the core repository API, built from scratch.

## What it serves

One process, standard library only (Node 22, no dependencies), speaking four surfaces over a single in-memory store:

- **Git smart HTTP** — protocol v2 (`ls-refs`, `fetch` with have/want negotiation, shallow/deepen, `deepen-relative`) and v0, plus `receive-pack` with pack unpacking (OFS/REF deltas, thin packs), fast-forward enforcement, and per-ref `report-status`. Real `git` clones, fetches, and pushes against it.
- **REST v3** — repositories, branches, git refs, commits, contents (create/update/delete with sha guards), labels, issues, comments, and pull requests with three-way squash/merge and conflict detection.
- **GraphQL v4** — a hand-written executor for the viewer/repository/issue/pull-request schema, including `node(id:)` global ids, `__type` introspection, cursor pagination, and batched operations.
- **MCP** — JSON-RPC over Streamable HTTP with `server/discover`, the legacy `initialize` handshake, and six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).

## Layout

- `main.ts` — the trial lifecycle: bind an ephemeral port, register with the environment, poll until done.
- `app.ts` — the HTTP server: routing, bearer auth, request ids, error boundaries.
- `store.ts` — the in-memory forge: repositories, objects, refs, issues, pull requests, and the deterministic trial clock.
- `git.ts` — git objects, packs, reachability, merges, and diffs.
- `githttp.ts` — pkt-lines, advertisements, fetch negotiation, receive-pack.
- `rest.ts`, `graphql.ts`, `mcp.ts` — the three API surfaces over the shared store.

## Running it

The entry runs under the trial harness as `node /bot/main.ts`, with `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` in the environment. It takes all timestamps from `MAKEFUN_TRIAL_NOW`, so identical request streams produce identical responses.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
