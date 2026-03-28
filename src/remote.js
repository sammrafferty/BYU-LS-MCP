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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { createAdapter } from "./data/adapter.js";
import { registerTools } from "./tools/index.js";
import { generateToken, registerUser, getUser, listUsers } from "./sessions.js";

const PORT = process.env.PORT || 3847;
const app = express();

// CORS for Chrome extension
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
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
    cookies = cookies.split("; ").map((pair) => {
      const idx = pair.indexOf("=");
      return {
        name: pair.slice(0, idx),
        value: pair.slice(idx + 1),
        domain: "learningsuite.byu.edu",
      };
    });
  }

  if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
    return res.status(400).json({ error: "Missing or invalid cookies" });
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

app.get("/", (req, res) => {
  const SERVER = `${req.protocol}://${req.get("host")}`;
  const bookmarkletCode = `javascript:void((function(){if(!location.hostname.includes('learningsuite.byu.edu')){alert('Open Learning Suite first, then click this bookmark.');return;}var c=document.cookie;var m=location.href.match(/\\.(\\w{4})\\//);var s=m?m[1]:'';var o=document.createElement('div');o.id='_byu_mcp_overlay';o.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:999999;display:flex;align-items:center;justify-content:center;font-family:system-ui';o.innerHTML='<div style=\"background:%231a1a2e;border-radius:16px;padding:32px;max-width:420px;width:90%25;color:%23fff;text-align:center\"><div style=\"font-size:20px;font-weight:700;margin-bottom:8px\">Connecting...</div><div style=\"color:%238890a4;font-size:13px\">Please wait</div></div>';document.body.appendChild(o);fetch('${SERVER}/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookies:c,sessionCode:s})}).then(function(r){return r.json()}).then(function(d){if(d.error){throw new Error(d.error)}var url='${SERVER}'+d.mcpUrl;o.innerHTML='<div style=\"background:%231a1a2e;border-radius:16px;padding:32px;max-width:420px;width:90%25;color:%23fff;text-align:center\"><div style=\"font-size:24px;margin-bottom:4px\">Connected!</div><div style=\"color:%238890a4;font-size:13px;margin-bottom:20px\">Copy this URL into Claude Desktop</div><input id=_mcp_url value=\"'+url+'\" readonly onclick=\"this.select()\" style=\"width:100%25;padding:12px;border-radius:8px;border:1px solid %23333;background:%230a0e1a;color:%237dd3fc;font-size:11px;font-family:monospace;margin-bottom:12px;box-sizing:border-box\"><button onclick=\"navigator.clipboard.writeText(\\''+url+'\\');this.textContent=\\'Copied!\\';this.style.background=\\'%230d2818\\';this.style.borderColor=\\'%231a4d2e\\';this.style.color=\\'%234ade80\\'\" style=\"width:100%25;padding:12px;border-radius:10px;border:1px solid %232a3e5c;background:%234a6cf7;color:%23fff;font-size:14px;font-weight:600;cursor:pointer\">Copy URL</button><div style=\"margin-top:16px;font-size:12px;color:%238890a4;line-height:1.6;text-align:left\">Open <b style=color:white>Claude Desktop</b> and go to:<br>Settings → Connectors → <b style=color:white>+</b> → Add custom connector<br>Paste the URL → click <b style=color:white>Add</b></div></div>';o.onclick=function(e){if(e.target===o)o.remove()}}).catch(function(e){o.innerHTML='<div style=\"background:%231a1a2e;border-radius:16px;padding:32px;max-width:420px;width:90%25;color:%23fff;text-align:center\"><div style=\"font-size:20px;margin-bottom:8px\">Something went wrong</div><div style=\"color:%23f87171;font-size:13px\">'+e.message+'</div><button onclick=\"document.getElementById(\\'_byu_mcp_overlay\\').remove()\" style=\"margin-top:16px;padding:10px 24px;border-radius:8px;border:1px solid %23333;background:%231a1a2e;color:%23fff;cursor:pointer\">Close</button></div>'})})())`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BYU Learning Suite → Claude</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0a0e1a; color: #e0e4ef; min-height: 100vh; display: flex; justify-content: center; padding: 40px 20px; }
  .container { max-width: 520px; width: 100%; }
  h1 { font-size: 28px; font-weight: 700; color: #fff; margin-bottom: 6px; }
  .subtitle { color: #8890a4; font-size: 15px; margin-bottom: 36px; }
  .step { display: flex; gap: 16px; margin-bottom: 28px; }
  .step-num { flex-shrink: 0; width: 36px; height: 36px; border-radius: 50%; background: #1a2040; color: #4a6cf7; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px; border: 2px solid #2a3e5c; }
  .step-content h3 { font-size: 16px; color: #fff; margin-bottom: 6px; }
  .step-content p { font-size: 13px; color: #8890a4; line-height: 1.6; }

  /* Bookmarklet button */
  .bookmarklet-area { text-align: center; margin: 32px 0; padding: 28px; border: 2px dashed #2a3e5c; border-radius: 16px; background: #0d1120; }
  .bookmarklet-area p { font-size: 13px; color: #8890a4; margin-bottom: 16px; }
  .bookmarklet-btn { display: inline-block; padding: 16px 32px; background: #4a6cf7; color: #fff; font-size: 16px; font-weight: 700; border-radius: 12px; text-decoration: none; cursor: grab; box-shadow: 0 4px 24px rgba(74,108,247,0.3); transition: transform 0.15s, box-shadow 0.15s; }
  .bookmarklet-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 32px rgba(74,108,247,0.4); }
  .bookmarklet-btn:active { cursor: grabbing; }
  .arrow { font-size: 24px; margin-bottom: 8px; display: block; animation: bounce 1.5s infinite; }
  @keyframes bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }

  .note { margin-top: 32px; padding: 16px 20px; background: #12162a; border-radius: 10px; border-left: 3px solid #4a6cf7; font-size: 13px; color: #8890a4; line-height: 1.6; }
  .note b { color: #e0e4ef; }
</style>
</head>
<body>
<div class="container">
  <h1>BYU Learning Suite → Claude</h1>
  <div class="subtitle">Connect your classes to Claude in 30 seconds. No installs needed.</div>

  <div class="step">
    <div class="step-num">1</div>
    <div class="step-content">
      <h3>Drag this button to your bookmarks bar</h3>
      <p>Click and hold the blue button below, then drag it up to your browser's bookmarks bar. You only need to do this once.</p>
    </div>
  </div>

  <div class="bookmarklet-area">
    <span class="arrow">⬆</span>
    <p>Drag this button to your bookmarks bar</p>
    <a class="bookmarklet-btn" href="${bookmarkletCode}">📚 Connect to Claude</a>
  </div>

  <div class="step">
    <div class="step-num">2</div>
    <div class="step-content">
      <h3>Open Learning Suite and make sure you're logged in</h3>
      <p>Go to <a href="https://learningsuite.byu.edu" target="_blank" style="color:#7dd3fc">learningsuite.byu.edu</a> in this browser. If you can see your courses, you're good.</p>
    </div>
  </div>

  <div class="step">
    <div class="step-num">3</div>
    <div class="step-content">
      <h3>Click the bookmark</h3>
      <p>While on the Learning Suite page, click the "📚 Connect to Claude" bookmark you just saved. A popup will appear with your personal connector URL.</p>
    </div>
  </div>

  <div class="step">
    <div class="step-num">4</div>
    <div class="step-content">
      <h3>Paste the URL in Claude Desktop</h3>
      <p>Open Claude Desktop → Settings → Connectors → <b>+</b> → Add custom connector → paste the URL → <b>Add</b>. That's it — ask Claude about your assignments!</p>
    </div>
  </div>

  <div class="note">
    <b>How it works:</b> The bookmark reads your Learning Suite session (the same one your browser uses) and connects it to Claude. Your BYU credentials are never shared — only the session cookie, which expires naturally. Re-run the bookmark anytime if your session expires.
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
