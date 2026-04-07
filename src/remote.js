#!/usr/bin/env node

/**
 * Remote MCP server for BYU Learning Suite.
 *
 * Two authentication paths:
 * 1. OAuth 2.1 (claude.ai): /mcp with Bearer token — discovered via .well-known
 * 2. Legacy (Claude Desktop): /mcp/:token — bookmarklet provides URL directly
 *
 * Both paths share the same MCP tools and session management.
 */

import express from "express";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { randomUUID } from "crypto";
import { createAdapter } from "./data/adapter.js";
import { registerTools } from "./tools/index.js";
import { generateToken, registerUser, updateUserCookies, getUser, listUsers, revokeUser, getAllTokens } from "./sessions.js";
import { BYUOAuthProvider } from "./auth/oauth-provider.js";

const PORT = process.env.PORT || 3847;
const app = express();

// Trust Railway's reverse proxy so req.protocol reflects the real scheme
app.set("trust proxy", 1);

// Server URL for OAuth metadata (must be known at startup)
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;
const serverUrl = new URL(SERVER_URL);

// --- OAuth 2.1 setup ---

const oauthProvider = new BYUOAuthProvider(serverUrl);

// mcpAuthRouter installs: /authorize, /token, /register,
// /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource/mcp
app.use(mcpAuthRouter({
  provider: oauthProvider,
  issuerUrl: serverUrl,
  scopesSupported: [],
  resourceServerUrl: new URL("/mcp", serverUrl),
}));

// --- CORS ---

app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const allowed = ["https://learningsuite.byu.edu", "http://localhost"];
  if (allowed.some((a) => origin.startsWith(a)) || !origin) {
    res.header("Access-Control-Allow-Origin", origin || "*");
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "5mb" }));

// Health check for Railway
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Track active MCP transports per connection
const activeTransports = new Map();

// --- Auth endpoints ---

// Simple rate limiter for auth endpoint
const authAttempts = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 5;

function checkRateLimit(ip) {
  const now = Date.now();
  const attempts = authAttempts.get(ip) || [];
  const recent = attempts.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) return false;
  recent.push(now);
  authAttempts.set(ip, recent);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, attempts] of authAttempts) {
    const recent = attempts.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length === 0) authAttempts.delete(ip);
    else authAttempts.set(ip, recent);
  }
}, 5 * 60 * 1000);

// OAuth flow status polling (used by the authorize page)
app.get("/auth/flow-status/:flowId", (req, res) => {
  const status = oauthProvider.getFlowStatus(req.params.flowId);
  res.json(status);
});

// Register a new user (called by bookmarklet, CLI, or Chrome extension)
app.post("/auth/register", async (req, res) => {
  if (!checkRateLimit(req.ip)) {
    return res.status(429).json({ error: "Too many attempts. Try again in a minute." });
  }

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

  // If the bookmarklet sends an existing token, reuse it (stable URL)
  const { existingToken } = req.body;
  let token;

  if (existingToken && getUser(existingToken)) {
    updateUserCookies(existingToken, cookies, sessionCode);
    token = existingToken;
    console.log(`[AUTH] Session refreshed (token: ${token.slice(0, 8)}...)`);
  } else if (existingToken) {
    registerUser(existingToken, { cookies, sessionCode });
    token = existingToken;
    console.log(`[AUTH] Session restored (token: ${token.slice(0, 8)}...)`);
  } else {
    token = generateToken();
    registerUser(token, { cookies, sessionCode });
    console.log(`[AUTH] New user registered (token: ${token.slice(0, 8)}...)`);
  }

  startKeepAlive(token);

  // If this registration is part of an OAuth flow, complete it
  const { flowId } = req.body;
  let flowCompleted = false;
  if (flowId) {
    flowCompleted = oauthProvider.completeFlow(flowId, token);
    if (flowCompleted) {
      console.log(`[AUTH] OAuth flow ${flowId.slice(0, 8)}... linked to session`);
    }
  }

  res.json({
    token,
    mcpUrl: `/mcp/${token}`,
    flowCompleted,
  });
});

// Check auth status
app.get("/auth/status/:token", (req, res) => {
  const user = getUser(req.params.token);
  if (!user) return res.status(404).json({ error: "Token not found" });
  res.json({ status: "active", registeredAt: user.registeredAt, lastUsed: user.lastUsed });
});

app.delete("/auth/revoke/:token", (req, res) => {
  const removed = revokeUser(req.params.token);
  if (!removed) return res.status(404).json({ error: "Token not found" });
  res.json({ status: "revoked" });
});

// Debug: test if stored cookies can actually reach LS
app.get("/auth/debug/:token", async (req, res) => {
  const user = getUser(req.params.token);
  if (!user) return res.status(404).json({ error: "Token not found" });

  const cookieHeader = user.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const cookieNames = user.cookies.map((c) => c.name);
  const url = `https://learningsuite.byu.edu/.${user.sessionCode}/student/top`;

  try {
    const lsRes = await fetch(url, {
      headers: { Cookie: cookieHeader, "User-Agent": "Mozilla/5.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });

    const location = lsRes.headers.get("location") || "";
    const isCasRedirect = location.includes("cas.byu.edu");

    if (isCasRedirect) {
      return res.json({
        status: "session_expired",
        detail: "LS redirected to CAS login — cookies are no longer valid",
        sessionCode: user.sessionCode,
        cookieCount: user.cookies.length,
        cookieNames,
      });
    }

    if (lsRes.status === 200) {
      const body = await lsRes.text();
      const hasCourseData = body.includes("initialCourseGroups");
      return res.json({
        status: hasCourseData ? "working" : "auth_ok_but_no_data",
        detail: hasCourseData
          ? "Cookies work! LS returned course data."
          : "LS returned 200 but no course data found in HTML.",
        httpStatus: 200,
        bodyLength: body.length,
        hasCourseData,
        sessionCode: user.sessionCode,
        cookieCount: user.cookies.length,
        cookieNames,
      });
    }

    return res.json({
      status: "unexpected",
      httpStatus: lsRes.status,
      location: location || null,
      sessionCode: user.sessionCode,
      cookieNames,
    });
  } catch (err) {
    return res.json({
      status: "error",
      detail: err.message,
      sessionCode: user.sessionCode,
      cookieNames,
    });
  }
});

// --- MCP endpoints ---

async function createMcpForUser(userToken) {
  const user = getUser(userToken);
  if (!user) return null;

  const { createScraperDataSource } = await import("./data/scraperAdapter.js");
  const authState = { cookies: user.cookies, sessionCode: user.sessionCode };
  const dataSource = await createScraperDataSource(authState);
  const data = createAdapter(dataSource);

  const server = new McpServer({
    name: "BYU Learning Suite",
    version: "1.0.0",
  });
  registerTools(server, data);
  return server;
}

// Shared MCP request handler (used by both OAuth and legacy paths)
async function handleMcpRequest(req, res, userToken) {
  const sessionId = req.headers["mcp-session-id"];

  if (req.method === "POST" && !sessionId) {
    const mcpServer = await createMcpForUser(userToken);
    if (!mcpServer) {
      return res.status(500).json({ error: "Failed to initialize MCP server" });
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        activeTransports.set(sid, { transport, mcpServer, userToken });
        console.log(`[MCP] Session started: ${sid.slice(0, 8)}... (user: ${userToken.slice(0, 8)}...)`);
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
}

// OAuth path: /mcp with Bearer token (claude.ai connectors)
const bearerAuth = requireBearerAuth({
  verifier: oauthProvider,
  requiredScopes: [],
});

app.all("/mcp", bearerAuth, async (req, res) => {
  const sessionToken = oauthProvider.getSessionTokenForAccessToken(req.auth.token);
  if (!sessionToken) {
    return res.status(401).json({ error: "Session expired. Re-authenticate the connector." });
  }
  await handleMcpRequest(req, res, sessionToken);
});

// Legacy path: /mcp/:token (Claude Desktop + bookmarklet users)
app.all("/mcp/:token", async (req, res) => {
  const { token } = req.params;
  const user = getUser(token);

  if (!user) {
    return res.status(401).json({
      error: "Invalid or expired token. Go to learningsuite.byu.edu, log in, and click the 'Connect to Claude' bookmark to reconnect.",
    });
  }

  await handleMcpRequest(req, res, token);
});

// --- Landing page ---

const __dirname = dirname(fileURLToPath(import.meta.url));
const bookmarkletTemplate = readFileSync(resolve(__dirname, "bookmarklet.js"), "utf-8");

app.get("/bookmarklet.js", (req, res) => {
  const SERVER = `${req.protocol}://${req.get("host")}`;
  const js = bookmarkletTemplate.replace("%%SERVER_URL%%", SERVER);
  res.type("application/javascript").send(js);
});

app.get("/", (req, res) => {
  const SERVER = `${req.protocol}://${req.get("host")}`;
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

  body::after {
    content: '';
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
    pointer-events: none;
    z-index: 100;
  }

  .page { max-width: 640px; margin: 0 auto; padding: 80px 32px 60px; }

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

  .divider { width: 100%; height: 1px; background: #222; margin: 48px 0; }

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
  .step p { font-size: 13px; line-height: 1.7; color: #666; }
  .step a { color: #888; text-decoration: underline; text-underline-offset: 3px; }
  .step a:hover { color: #fff; }

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
      <p>Go to <a href="https://learningsuite.byu.edu" target="_blank">learningsuite.byu.edu</a> and make sure you're logged in.</p>
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

// --- Session keep-alive ---

const keepAliveIntervals = new Map();
const keepAliveFailures = new Map();
const KEEP_ALIVE_MS = 8 * 60 * 1000;
const KEEP_ALIVE_MAX_IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 3;

function startKeepAlive(token) {
  stopKeepAlive(token);
  keepAliveFailures.set(token, 0);

  const interval = setInterval(async () => {
    const user = getUser(token);
    if (!user) { stopKeepAlive(token); return; }

    const lastUsed = new Date(user.lastUsed).getTime();
    if (Date.now() - lastUsed > KEEP_ALIVE_MAX_IDLE_MS) {
      console.log(`[KEEPALIVE] Stopping for ${token.slice(0, 8)}... (idle >12h)`);
      stopKeepAlive(token);
      return;
    }

    const cookieHeader = user.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    try {
      const pingRes = await fetch(`https://learningsuite.byu.edu/.${user.sessionCode}/student/top`, {
        headers: { Cookie: cookieHeader, "User-Agent": "Mozilla/5.0" },
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      });

      const location = pingRes.headers.get("location") || "";
      if (location.includes("cas.byu.edu")) {
        const fails = (keepAliveFailures.get(token) || 0) + 1;
        keepAliveFailures.set(token, fails);
        console.log(`[KEEPALIVE] Session expired for ${token.slice(0, 8)}... (attempt ${fails}/${MAX_CONSECUTIVE_FAILURES})`);
        if (fails >= MAX_CONSECUTIVE_FAILURES) {
          console.log(`[KEEPALIVE] Giving up for ${token.slice(0, 8)}... — waiting for extension refresh`);
          stopKeepAlive(token);
        }
        return;
      }

      keepAliveFailures.set(token, 0);
    } catch (err) {
      const fails = (keepAliveFailures.get(token) || 0) + 1;
      keepAliveFailures.set(token, fails);
      console.log(`[KEEPALIVE] Ping failed for ${token.slice(0, 8)}... (${err.message}) attempt ${fails}/${MAX_CONSECUTIVE_FAILURES}`);
      if (fails >= MAX_CONSECUTIVE_FAILURES) {
        console.log(`[KEEPALIVE] Giving up for ${token.slice(0, 8)}... — waiting for extension refresh`);
        stopKeepAlive(token);
      }
    }
  }, KEEP_ALIVE_MS);

  keepAliveIntervals.set(token, interval);
}

function stopKeepAlive(token) {
  const interval = keepAliveIntervals.get(token);
  if (interval) {
    clearInterval(interval);
    keepAliveIntervals.delete(token);
  }
  keepAliveFailures.delete(token);
}

// --- Start server ---

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[SERVER] BYU Learning Suite MCP running on port ${PORT}`);
  console.log(`[SERVER] OAuth: ${serverUrl.href}`);
  console.log(`[SERVER] MCP (OAuth): ${serverUrl.href}mcp`);
  console.log(`[SERVER] MCP (legacy): ${serverUrl.href}mcp/:token`);

  // Restart keep-alive pings for all persisted sessions
  const tokens = getAllTokens();
  for (const token of tokens) {
    startKeepAlive(token);
  }
  if (tokens.length > 0) {
    console.log(`[SERVER] Restarted keep-alive for ${tokens.length} persisted session(s)`);
  }
});
