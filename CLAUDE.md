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

Two operating modes, same tools:

**Local** (`src/index.js`): stdio transport → Claude Desktop reads from `claude_desktop_config.json`
**Remote** (`src/remote.js`): HTTP/SSE transport → Claude Desktop connects via custom connector URL (`/mcp/:token`)

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

### Remote Server Auth

Two methods send cookies to the server:

1. **Chrome Extension (recommended)**: Background service worker (`extension/background.js`) reads LS cookies via `chrome.cookies` API every 10 minutes and POSTs to `/auth/register`. Also triggers immediately when a new PHPSESSID appears (user just logged in). Fully automatic — user never needs to click anything after initial setup.

2. **Bookmarklet (fallback)**: `src/bookmarklet.js` runs on the LS page, reads `document.cookie`, and POSTs to `/auth/register`. Manual click required.

Both methods: server generates a token, stores cookies in `sessions.json` (file-backed, survives process restarts). Token is stored in Chrome extension storage / LS localStorage for reuse. Each `/mcp/:token` request creates a per-user scraper instance.

Sessions persist to disk (`sessions.json`) and reload on server startup. Keep-alive pings LS every 8 minutes with retry logic (3 failures before stopping).

### Error Pattern

All adapter methods are wrapped with `wrapErrors()` — catches `SessionExpiredError` and `ParseError`, returns `{ error: "message" }` instead of throwing. Tools check for `.error` property and set `isError: true` in MCP response via `formatResult()`.

## Deployed At

- **Railway**: `byu-ls-mcp-production.up.railway.app` (auto-deploys from GitHub main)
- **GitHub**: `github.com/sammrafferty/BYU-LS-MCP`
- Pushes to main trigger Railway rebuild via Dockerfile
