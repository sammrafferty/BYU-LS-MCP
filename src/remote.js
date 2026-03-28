#!/usr/bin/env node

/**
 * Remote MCP server for BYU Learning Suite.
 *
 * Serves the MCP protocol over HTTP so anyone with Claude Desktop
 * can add it as a custom connector. Each user authenticates separately
 * via the CLI auth tool and gets a personal token.
 *
 * Usage:
 *   npm run remote          # start server
 *   npm run auth:remote     # authenticate and get a token
 *
 * Connector URL format: https://yourserver.com/mcp/YOUR_TOKEN
 */

import express from "express";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { createAdapter } from "./data/adapter.js";
import { registerTools } from "./tools/index.js";
import { generateToken, registerUser, getUser, listUsers } from "./sessions.js";

const PORT = process.env.PORT || 3847;
const app = express();

// CORS — allow bookmarklet requests from LS and MCP requests from Claude
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const allowed = ["https://learningsuite.byu.edu", "http://localhost"];
  if (allowed.some((a) => origin.startsWith(a)) || !origin) {
    res.header("Access-Control-Allow-Origin", origin || "*");
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "5mb" }));

// Health check for Railway
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Track active MCP transports per connection
const activeTransports = new Map();

// --- Auth endpoints ---

// Register a new user (called by bookmarklet, CLI, or Chrome extension)
app.post("/auth/register", async (req, res) => {
  let { cookies } = req.body;
  let { sessionCode } = req.body;

  // Handle bookmarklet format: cookies as "name=value; name=value" string
  if (typeof cookies === "string") {
    cookies = cookies
      .split("; ")
      .filter((pair) => pair.includes("="))
      .map((pair) => {
        const idx = pair.indexOf("=");
        return {
          name: pair.slice(0, idx),
          value: pair.slice(idx + 1),
          domain: "learningsuite.byu.edu",
        };
      })
      .filter((c) => c.name && c.value);
  }

  if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
    return res.status(400).json({ error: "No valid cookies found. Make sure you're logged into Learning Suite." });
  }

  // Verify we have the critical session cookie
  const hasSession = cookies.some((c) => c.name === "PHPSESSID");
  if (!hasSession) {
    return res.status(400).json({ error: "Session cookie not found. Please log into Learning Suite and try again." });
  }

  // Auto-detect session code if not provided or set to AUTO
  if (!sessionCode || sessionCode === "AUTO") {
    try {
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const probe = await fetch("https://learningsuite.byu.edu", {
        headers: { Cookie: cookieHeader },
        redirect: "manual",
      });
      const location = probe.headers.get("location") || "";
      const match = location.match(/\.(\w{4})\//);
      if (match) {
        sessionCode = match[1];
        console.log(`[AUTH] Auto-detected session code: ${sessionCode}`);
      } else {
        // Try following the redirect
        const probe2 = await fetch("https://learningsuite.byu.edu", {
          headers: { Cookie: cookieHeader },
          redirect: "follow",
        });
        const body = await probe2.text();
        const bodyMatch = body.match(/global_subsessionID\s*=\s*"(\w+)"/);
        if (bodyMatch) {
          sessionCode = bodyMatch[1];
          console.log(`[AUTH] Auto-detected session code from page: ${sessionCode}`);
        }
      }
    } catch (err) {
      console.log(`[AUTH] Session code auto-detect failed: ${err.message}`);
    }
  }

  if (!sessionCode) {
    return res.status(400).json({
      error: "Could not determine session code. Make sure you're logged into Learning Suite and try again.",
    });
  }

  const token = generateToken();
  registerUser(token, { cookies, sessionCode });

  console.log(`[AUTH] New user registered (token: ${token.slice(0, 8)}...)`);

  res.json({
    token,
    mcpUrl: `/mcp/${token}`,
  });
});

// Check auth status
app.get("/auth/status/:token", (req, res) => {
  const user = getUser(req.params.token);
  if (!user) return res.status(404).json({ error: "Token not found" });
  res.json({ status: "active", registeredAt: user.registeredAt, lastUsed: user.lastUsed });
});

// --- MCP endpoints (per-user) ---

async function createMcpForUser(userToken) {
  const user = getUser(userToken);
  if (!user) return null;

  // Create a scraper data source for this user's cookies
  const { createScraperDataSource } = await import("./data/scraperAdapter.js");

  // Temporarily override loadAuthState to return this user's cookies
  const authState = { cookies: user.cookies, sessionCode: user.sessionCode };
  const dataSource = await createScraperDataSourceFromAuth(authState);
  const data = createAdapter(dataSource);

  const server = new McpServer({
    name: "BYU Learning Suite",
    version: "1.0.0",
  });
  registerTools(server, data);
  return server;
}

// Handle MCP requests for a specific user token
app.all("/mcp/:token", async (req, res) => {
  const { token } = req.params;
  const user = getUser(token);

  if (!user) {
    return res.status(401).json({
      error: "Invalid or expired token. Run 'npm run auth:remote' to authenticate.",
    });
  }

  // Get or create transport for this connection
  const sessionId = req.headers["mcp-session-id"];

  if (req.method === "POST" && !sessionId) {
    // New session — create MCP server and transport
    const mcpServer = await createMcpForUser(token);
    if (!mcpServer) {
      return res.status(500).json({ error: "Failed to initialize MCP server" });
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        activeTransports.set(sid, { transport, mcpServer, userToken: token });
        console.log(`[MCP] Session started: ${sid.slice(0, 8)}... (user: ${token.slice(0, 8)}...)`);
      },
      onsessionclosed: (sid) => {
        activeTransports.delete(sid);
        console.log(`[MCP] Session closed: ${sid.slice(0, 8)}...`);
      },
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (sessionId && activeTransports.has(sessionId)) {
    const { transport } = activeTransports.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({ error: "Invalid or missing session. Reconnect the connector." });
});

// --- Landing page ---

// Serve bookmarklet JS (loaded dynamically, avoids all encoding issues)
const __dirname = dirname(fileURLToPath(import.meta.url));
const bookmarkletTemplate = readFileSync(resolve(__dirname, "bookmarklet.js"), "utf-8");

app.get("/bookmarklet.js", (req, res) => {
  const SERVER = `${req.protocol}://${req.get("host")}`;
  const js = bookmarkletTemplate.replace("%%SERVER_URL%%", SERVER);
  res.type("application/javascript").send(js);
});

app.get("/", (req, res) => {
  const SERVER = `${req.protocol}://${req.get("host")}`;
  // Simple bookmarklet that loads the full script from the server
  const bookmarkletHref = `javascript:void(document.head.appendChild(document.createElement('script')).src='${SERVER}/bookmarklet.js?t='+Date.now())`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BYU Learning Suite / Claude</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Space Mono', monospace;
    background: #0a0a0a;
    color: #a0a0a0;
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* Film grain overlay */
  body::after {
    content: '';
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
    pointer-events: none;
    z-index: 100;
  }

  .page { max-width: 640px; margin: 0 auto; padding: 80px 32px 60px; }

  /* Header */
  .hero { margin-bottom: 64px; }
  h1 {
    font-family: 'Playfair Display', serif;
    font-weight: 900;
    font-size: clamp(48px, 10vw, 72px);
    color: #ffffff;
    line-height: 0.95;
    letter-spacing: -2px;
    text-transform: uppercase;
    margin-bottom: 16px;
  }
  .tagline {
    font-size: 13px;
    color: #555;
    letter-spacing: 2px;
    text-transform: uppercase;
  }

  /* Divider */
  .divider {
    width: 100%;
    height: 1px;
    background: #222;
    margin: 48px 0;
  }

  /* Steps */
  .step {
    display: grid;
    grid-template-columns: 40px 1fr;
    gap: 16px;
    margin-bottom: 40px;
    align-items: start;
  }
  .step-num {
    font-family: 'Playfair Display', serif;
    font-size: 32px;
    font-weight: 900;
    color: #333;
    line-height: 1;
  }
  .step h3 {
    font-family: 'Space Mono', monospace;
    font-size: 14px;
    font-weight: 700;
    color: #fff;
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 1px;
  }
  .step p {
    font-size: 13px;
    line-height: 1.7;
    color: #666;
  }
  .step a { color: #888; text-decoration: underline; text-underline-offset: 3px; }
  .step a:hover { color: #fff; }

  /* Bookmarklet */
  .drag-zone {
    text-align: center;
    margin: 48px 0;
    padding: 40px 24px;
    border: 1px solid #222;
    position: relative;
  }
  .drag-zone::before {
    content: 'DRAG TO BOOKMARKS BAR';
    position: absolute;
    top: -10px;
    left: 24px;
    background: #0a0a0a;
    padding: 0 12px;
    font-size: 10px;
    letter-spacing: 3px;
    color: #444;
  }
  .drag-zone .arrow {
    display: block;
    font-size: 20px;
    color: #333;
    margin-bottom: 20px;
    animation: float 2s ease-in-out infinite;
  }
  @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }

  .bookmarklet-btn {
    display: inline-block;
    padding: 18px 40px;
    background: #fff;
    color: #0a0a0a;
    font-family: 'Playfair Display', serif;
    font-size: 18px;
    font-weight: 900;
    text-decoration: none;
    text-transform: uppercase;
    letter-spacing: 2px;
    cursor: grab;
    transition: all 0.2s;
  }
  .bookmarklet-btn:hover {
    background: #e0e0e0;
    transform: translateY(-2px);
    box-shadow: 0 8px 32px rgba(255,255,255,0.08);
  }
  .bookmarklet-btn:active { cursor: grabbing; }

  /* Footer note */
  .note {
    margin-top: 64px;
    padding-top: 24px;
    border-top: 1px solid #1a1a1a;
    font-size: 11px;
    color: #444;
    line-height: 1.8;
  }
  .note b { color: #666; }
</style>
</head>
<body>
<div class="page">
  <div class="hero">
    <h1>Learning<br>Suite<br>/ Claude</h1>
    <div class="tagline">Connect your BYU classes to AI in 30 seconds</div>
  </div>

  <div class="divider"></div>

  <div class="step">
    <div class="step-num">1</div>
    <div>
      <h3>Drag the button</h3>
      <p>Click and hold the white button below. Drag it up to your browser's bookmarks bar. One time only.</p>
    </div>
  </div>

  <div class="drag-zone">
    <span class="arrow">&uarr;</span>
    <a class="bookmarklet-btn" href="${bookmarkletHref}">Connect to Claude</a>
  </div>

  <div class="step">
    <div class="step-num">2</div>
    <div>
      <h3>Open Learning Suite</h3>
      <p>Go to <a href="https://learningsuite.byu.edu" target="_blank">learningsuite.byu.edu</a> and make sure you're logged in. If you can see your courses, you're good.</p>
    </div>
  </div>

  <div class="step">
    <div class="step-num">3</div>
    <div>
      <h3>Click the bookmark</h3>
      <p>While on Learning Suite, click the "Connect to Claude" bookmark. A popup will appear with your personal URL.</p>
    </div>
  </div>

  <div class="step">
    <div class="step-num">4</div>
    <div>
      <h3>Paste in Claude</h3>
      <p>Open Claude Desktop. Go to Settings, then Connectors, click +, paste the URL, and click Add. That's it.</p>
    </div>
  </div>

  <div class="note">
    <b>How it works</b> &mdash; The bookmark reads your Learning Suite session cookie and connects it to Claude. Your BYU credentials are never transmitted. The session expires naturally. Re-click the bookmark anytime to reconnect.
  </div>
</div>
</body>
</html>`);
});

// --- Start server ---

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[SERVER] BYU Learning Suite MCP running on port ${PORT}`);
  console.log(`[SERVER] MCP endpoint: http://localhost:${PORT}/mcp/:token`);
  console.log(`[SERVER] Auth endpoint: http://localhost:${PORT}/auth/register`);
});

// --- Helper: create scraper from explicit auth state ---

async function createScraperDataSourceFromAuth(authState) {
  const { createHttpClient } = await import("./scraper/http.js");
  const { SessionExpiredError, ParseError } = await import("./scraper/errors.js");
  const parsers = await import("./scraper/parsers.js");
  const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import("fs");
  const { join } = await import("path");
  const { homedir } = await import("os");

  const http = createHttpClient(authState);
  const cache = new Map();
  const CACHE_TTL_MS = 5 * 60 * 1000;

  function getCached(key) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) return entry.data;
    return null;
  }
  function setCache(key, data) {
    cache.set(key, { data, timestamp: Date.now() });
  }

  function matchesCourse(item, courseFilter) {
    if (!courseFilter) return true;
    const filter = courseFilter.toLowerCase();
    return (
      (item.courseName && item.courseName.toLowerCase().includes(filter)) ||
      (item.courseCode && item.courseCode.toLowerCase().includes(filter))
    );
  }

  async function getCourses() {
    const cached = getCached("courses");
    if (cached) return cached;
    const html = await http.get("student/top");
    const courses = parsers.parseCourseList(html);
    setCache("courses", courses);
    return courses;
  }

  async function getGradebookData(course) {
    const key = `gradebook-${course.courseId}`;
    const cached = getCached(key);
    if (cached) return cached;
    const html = await http.get(`cid-${course.courseId}/student/gradebook`);
    const data = parsers.parseGradebook(html);
    setCache(key, data);
    return data;
  }

  function wrapErrors(fn) {
    return async (params) => {
      try {
        return await fn(params);
      } catch (err) {
        if (err instanceof SessionExpiredError) return { error: err.message };
        if (err instanceof ParseError) return { error: `Parse error: ${err.message}` };
        return { error: `Error: ${err.message}` };
      }
    };
  }

  // Import the full local adapter and re-create it with our auth state
  // This is a simplified version — for the remote server, we replicate
  // the key methods from scraperAdapter but with injected auth
  const { createScraperDataSource } = await import("./data/scraperAdapter.js");

  // Monkey-patch: temporarily replace the auth loading
  // Actually, let's just re-export a factory that accepts auth state
  // For now, use the simplified inline approach for core methods

  return {
    getAssignments: wrapErrors(async ({ course, daysAhead = 14 } = {}) => {
      const now = new Date();
      const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
      const courses = await getCourses();
      const filtered = courses.filter((c) => matchesCourse(c, course));
      const results = [];
      for (const c of filtered) {
        const gb = await getGradebookData(c);
        for (const a of gb.rawAssignments) {
          if (!a.dueDate) continue;
          const due = new Date(a.dueDate.replace(" ", "T") + "-07:00");
          if (due < now || due > cutoff) continue;
          const hasScore = gb.rawScores.has(a.id);
          results.push({
            courseName: c.courseName, title: a.name,
            dueDate: due.toISOString(), pointsPossible: a.points,
            status: hasScore ? "submitted" : "not submitted",
            category: "homework",
          });
        }
      }
      return results.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    }),

    getGrades: wrapErrors(async ({ course } = {}) => {
      const courses = await getCourses();
      if (course) {
        const match = courses.find((c) => matchesCourse(c, course));
        if (!match) return { error: `No course found matching "${course}"` };
        const gb = await getGradebookData(match);
        return { courseName: match.courseName, courseCode: match.courseCode, currentPercentage: gb.currentPercentage, letterGrade: gb.letterGrade, categories: gb.categories, assignmentScores: gb.assignmentScores };
      }
      const summaries = [];
      for (const c of courses) {
        const gb = await getGradebookData(c);
        summaries.push({ courseName: c.courseName, courseCode: c.courseCode, currentPercentage: gb.currentPercentage, letterGrade: gb.letterGrade, categories: gb.categories });
      }
      return summaries;
    }),

    getSchedule: wrapErrors(async () => {
      const courses = await getCourses();
      const html = await http.get("student/top/schedule");
      const scheduleData = parsers.parseGlobalSchedule(html);
      return courses.map((c) => {
        const sched = scheduleData.find((s) => s.courseId === c.courseId);
        return { courseName: c.courseName, courseCode: c.courseCode, days: [], startTime: sched?.startTime, endTime: null, building: sched?.building, room: sched?.room, instructor: null };
      });
    }),

    getAnnouncements: wrapErrors(async ({ course, limit = 10 } = {}) => {
      const html = await http.get("student/top/announcements");
      let all = parsers.parseAllAnnouncements(html);
      const courses = await getCourses();
      const codeToName = new Map();
      for (const c of courses) { if (c.courseCode) codeToName.set(c.courseCode, c.courseName); }
      let filtered = all.map((a) => ({ courseName: codeToName.get(a.courseCode) || a.courseCode || "Unknown", postedDate: a.postedDate, title: a.title, body: a.body?.length > 500 ? a.body.slice(0, 497) + "..." : a.body, author: a.author }));
      if (course) filtered = filtered.filter((a) => matchesCourse(a, course));
      return filtered.sort((a, b) => new Date(b.postedDate || 0) - new Date(a.postedDate || 0)).slice(0, limit);
    }),

    getExams: wrapErrors(async ({ course } = {}) => {
      const now = new Date();
      const courses = await getCourses();
      const filtered = courses.filter((c) => matchesCourse(c, course));
      const results = [];
      for (const c of filtered) {
        const html = await http.get(`cid-${c.courseId}/student/exam`);
        const exams = parsers.parseCourseExams(html);
        for (const e of exams) {
          if (e.examDate && new Date(e.examDate) < now) continue;
          results.push({ courseName: c.courseName, title: e.title, examDate: e.examDate, startWindow: e.startWindow, endWindow: e.endWindow, location: null, notes: e.status === "complete" ? "Completed" : null });
        }
      }
      return results.sort((a, b) => new Date(a.examDate || "9999") - new Date(b.examDate || "9999"));
    }),

    getContent: wrapErrors(async () => { return [{ courseName: "Note", section: "", title: "Content pages require browser rendering.", type: "note", url: null }]; }),

    getAssignmentDetails: wrapErrors(async ({ course, assignment } = {}) => {
      if (!course || !assignment) return { error: "Both course and assignment are required." };
      const courses = await getCourses();
      const match = courses.find((c) => matchesCourse(c, course));
      if (!match) return { error: `No course found matching "${course}"` };
      const gb = await getGradebookData(match);
      const search = assignment.toLowerCase();
      const found = gb.rawAssignments.filter((a) => a.name.toLowerCase().includes(search));
      if (!found.length) return { error: `No assignment matching "${assignment}"` };
      return found.map((a) => {
        const desc = (a.description || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&mdash;/g, "—").replace(/\n{3,}/g, "\n\n").trim();
        const files = [...(a.description || "").matchAll(/embededFile_Name">([^<]+)<\/span>.*?fileDownload\.php\?fileId=([^"'&]+)/gs)].map((m) => ({ fileName: m[1].trim(), downloadUrl: `https://learningsuite.byu.edu/plugins/Upload/fileDownload.php?fileId=${m[2]}` }));
        return { courseName: match.courseName, courseCode: match.courseCode, title: a.name, description: desc || "No description.", dueDate: a.dueDate, dueDateFormatted: a.fullDueTime, pointsPossible: a.points, status: gb.rawScores.has(a.id) ? "graded" : "not submitted", files };
      });
    }),

    downloadFiles: wrapErrors(async () => { return { error: "File downloads are not available on the remote server. Use get_assignment_details to get download URLs." }; }),

    whatIfGrade: wrapErrors(async ({ course, targetGrade } = {}) => {
      if (!course) return { error: "Course is required." };
      const courses = await getCourses();
      const match = courses.find((c) => matchesCourse(c, course));
      if (!match) return { error: `No course found matching "${course}"` };
      const gb = await getGradebookData(match);
      if (targetGrade && gb._gradeScale?.items) {
        const threshold = gb._gradeScale.items[targetGrade];
        if (threshold === undefined) return { error: `Grade "${targetGrade}" not found.` };
        return { courseName: match.courseName, currentGrade: `${gb.currentPercentage}% (${gb.letterGrade})`, targetGrade, targetThreshold: `${threshold}%`, gap: gb.currentPercentage != null ? `${(threshold - gb.currentPercentage).toFixed(2)}%` : null };
      }
      return { courseName: match.courseName, currentGrade: `${gb.currentPercentage}% (${gb.letterGrade})`, categories: gb.categories, gradeScale: gb._gradeScale?.items };
    }),

    getDeadlines: wrapErrors(async ({ daysAhead = 30, course } = {}) => {
      const now = new Date();
      const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
      const courses = await getCourses();
      const filtered = courses.filter((c) => matchesCourse(c, course));
      const deadlines = [];
      for (const c of filtered) {
        const gb = await getGradebookData(c);
        for (const a of gb.rawAssignments) {
          if (!a.dueDate || gb.rawScores.has(a.id)) continue;
          const due = new Date(a.dueDate.replace(" ", "T") + "-07:00");
          if (due < now || due > cutoff) continue;
          const daysUntil = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
          const urgency = daysUntil <= 2 ? 3 : daysUntil <= 7 ? 2 : 1;
          deadlines.push({ courseName: c.courseName, courseCode: c.courseCode, title: a.name, dueDate: due.toISOString(), dueDateFormatted: a.fullDueTime, daysUntil, pointsPossible: a.points, priority: a.points * urgency });
        }
      }
      return deadlines.sort((a, b) => b.priority - a.priority);
    }),

    getUniversityCalendar: wrapErrors(async () => {
      const html = await http.get("student/top/schedule");
      return parsers.parseUniversityCalendar(html);
    }),

    getSyllabus: wrapErrors(async () => { return { error: "Syllabus download not available on remote server." }; }),

    getGroupMembers: wrapErrors(async ({ course } = {}) => {
      const courses = await getCourses();
      const match = courses.find((c) => matchesCourse(c, course));
      if (!match) return { error: `No course found matching "${course}"` };
      const html = await http.get(`cid-${match.courseId}/student/home/groups`);
      const groups = parsers.parseGroupMembers(html, null);
      return { courseName: match.courseName, courseCode: match.courseCode, yourGroups: groups };
    }),

    searchAssignments: wrapErrors(async ({ query, course } = {}) => {
      if (!query) return { error: "Search query required." };
      const search = query.toLowerCase();
      const courses = await getCourses();
      const filtered = courses.filter((c) => matchesCourse(c, course));
      const results = [];
      for (const c of filtered) {
        const gb = await getGradebookData(c);
        for (const a of gb.rawAssignments) {
          if (!a.name.toLowerCase().includes(search) && !(a.description || "").toLowerCase().includes(search)) continue;
          results.push({ courseName: c.courseName, courseCode: c.courseCode, title: a.name, dueDate: a.dueDate, pointsPossible: a.points, status: gb.rawScores.has(a.id) ? "graded" : "not submitted" });
        }
      }
      return results;
    }),

    submitAssignment: wrapErrors(async () => { return { error: "Assignment submission not available on remote server." }; }),
  };
}
