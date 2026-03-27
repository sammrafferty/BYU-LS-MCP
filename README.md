# BYU Learning Suite MCP Server

A local MCP server that exposes BYU Learning Suite data (assignments, grades, schedule, announcements, exams, and course content) as tools for Claude Desktop.

Currently uses mock data for a BYU junior Finance student (Spring 2026). The data layer is modular — swap `mockAdapter.js` for a real scraper without changing any MCP logic.

## Setup

```bash
cd byu-learning-suite-mcp
npm install
```

## Run Standalone (for testing)

```bash
npm start
```

The server communicates over stdio, so you won't see output — it's waiting for MCP messages.

## Connect to Claude Desktop

Add the following to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "byu-learning-suite": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/byu-learning-suite-mcp/src/index.js"]
    }
  }
}
```

Replace the path with your actual absolute path, then restart Claude Desktop.

## Available Tools

| Tool | Description | Params |
|------|-------------|--------|
| `get_assignments` | Upcoming assignments | `course?`, `days_ahead?` (default 14) |
| `get_grades` | Grade summary (or drill into one course) | `course?` |
| `get_schedule` | Weekly class schedule | — |
| `get_announcements` | Recent announcements | `course?`, `limit?` (default 10) |
| `get_exams` | Upcoming exams & testing center windows | `course?` |
| `get_content` | Course content & resources | `course?` |

## Architecture

```
src/
├── index.js              # MCP server entry point
├── tools/
│   └── index.js          # Tool definitions (MCP schema + handlers)
└── data/
    ├── adapter.js        # Adapter interface (dependency injection point)
    ├── mockAdapter.js    # Mock implementation (filters/sorts mock data)
    └── mockData.js       # Raw mock data (courses, assignments, grades, etc.)
```

### Swapping to a Real Backend

1. Create `src/data/scraperAdapter.js` exporting an object with the same interface as `mockDataSource` (each method is async and returns the expected shape).
2. In `src/index.js`, import your scraper and pass it to `createAdapter()`:

```js
import { scraperDataSource } from "./data/scraperAdapter.js";
const data = createAdapter(scraperDataSource);
```

That's it — the tools and MCP server remain unchanged.
