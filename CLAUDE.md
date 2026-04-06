# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An MCP server that connects Claude to BYU Learning Suite — exposing 15 tools for assignments, grades, deadlines, exams, schedule, announcements, group members, file downloads, and grade calculations.

## Commands

```bash
npm start              # Local MCP server (stdio transport, for Claude Desktop config)
npm run remote         # Remote HTTP server (Express, port 3847, for cloud deployment)
npm run auth           # Playwright login flow — opens browser for BYU CAS + Duo, saves cookies to auth-state.json
npm run auth:remote    # Same but registers with remote server instead of saving locally
npm run discover       # Fetches real LS pages, saves HTML to debug/ for parser development
```

No test suite exists yet.

## Architecture

Three operating modes, same tools:

**Local** (`src/index.js`): stdio transport → Claude Desktop reads from `claude_desktop_config.json`
**Remote OAuth** (`src/remote.js`): OAuth 2.1 → claude.ai discovers at `/.well-known/oauth-authorization-server`, authenticates via `/authorize`, uses Bearer token on `/mcp`
**Remote Legacy** (`src/remote.js`): Direct token → bookmarklet provides `/mcp/:token` URL for Claude Desktop

### Data Flow

```
BYU Learning Suite HTML
    ↓ (HTTP with session cookies)
src/scraper/parsers.js        ← extracts JSON from embedded Vue/JS init scripts (regex, not DOM)
    ↓
src/data/scraperAdapter.js    ← caches (5 min TTL), filters, calculates grades
    ↓
src/data/adapter.js           ← dependency injection wrapper (swap mock ↔ scraper)
    ↓
src/tools/index.js            ← Zod schemas + MCP tool handlers
    ↓
McpServer                     ← stdio or StreamableHTTPServerTransport
```

### Key Design: Adapter Pattern

`createAdapter(source)` wraps any data source implementing the 15-method interface. `index.js` auto-detects: if `auth-state.json` exists → scraper, else → mock. To add a new data source, implement the same async method signatures as `mockAdapter.js`.

### LS Data Extraction

Learning Suite is NOT a REST API. It embeds data as JavaScript objects in server-rendered HTML (Vue component initialization). The parsers use `extractJSONAfter(html, prefix)` — a bracket-matching JSON extractor that finds a known prefix string (e.g., `"initialCourseGroups = "`) and parses the JSON that follows.

Key LS URL patterns:
- Dashboard: `student/top` — has `initialCourseGroups` (course list)
- Gradebook: `cid-{id}/student/gradebook` — has `datastore.categories.reset()`, `datastore.assignments.reset()`, `datastore.scores.reset()`, `datastore.gradeScale.set()`
- Announcements: `student/top/announcements` — has `allAnnouncements`
- Schedule: `student/top/schedule` — has `var courseInformation`
- Exams: `cid-{id}/student/exam` — has `instance.exams`
- Groups: `cid-{id}/student/home/groups` — has `var groupsMap` + `var students`

Score-to-assignment mapping uses `assignment.gbAssignmentID` (NOT `assignment.id`).

### Authentication & OAuth 2.1

**OAuth flow (claude.ai):**
1. Claude.ai discovers OAuth endpoints at `/.well-known/oauth-authorization-server`
2. Registers a client at `POST /register`
3. Opens `/authorize` — shows instructions to log into LS + click bookmarklet
4. Bookmarklet sends cookies + `flowId` to `POST /auth/register`
5. Authorize page polls `/auth/flow-status/:flowId`, auto-redirects when complete
6. Claude.ai exchanges code for access token at `POST /token`
7. MCP requests go to `/mcp` with `Authorization: Bearer <token>`

**OAuth provider** (`src/auth/oauth-provider.js`): Implements `OAuthServerProvider` from the MCP SDK. Uses the SDK's `mcpAuthRouter` for all standard endpoints. Stores clients, auth codes, and access tokens in `oauth-state.json`.

**Cookie delivery** — three methods:
1. **Bookmarklet** (`src/bookmarklet.js`): Runs on LS page, reads `document.cookie`, POSTs to `/auth/register`. Supports `flowId` param for OAuth flows.
2. **Chrome Extension** (`extension/background.js`): Background service worker sends cookies every 10 min. Auto-refreshes on new PHPSESSID.
3. **CLI** (`src/auth/remote-login.js`): Playwright opens browser, user logs in, cookies sent to server.

**Session management** (`src/sessions.js`): File-backed Map persisted to `sessions.json`. 7-day TTL. Keep-alive pings LS every 8 min with retry logic.

### Error Pattern

All adapter methods are wrapped with `wrapErrors()` — catches `SessionExpiredError` and `ParseError`, returns `{ error: "message" }` instead of throwing. Tools check for `.error` property and set `isError: true` in MCP response via `formatResult()`.

## Environment Variables

- `PORT` — Server port (default: 3847)
- `SERVER_URL` — Full public URL for OAuth metadata (e.g., `https://byu-ls-mcp-production.up.railway.app`). Required for production.
- `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL` — Set to `true` for local dev with `http://localhost`

## Deployed At

- **Railway**: `byu-ls-mcp-production.up.railway.app` (auto-deploys from GitHub main)
- **GitHub**: `github.com/sammrafferty/BYU-LS-MCP`
- Pushes to main trigger Railway rebuild via Dockerfile
- Railway env var `SERVER_URL` must be set to `https://byu-ls-mcp-production.up.railway.app`
