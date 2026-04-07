/**
 * OAuth 2.1 provider for the BYU Learning Suite MCP server.
 *
 * Implements OAuthServerProvider from the MCP SDK. The authorize flow
 * serves an HTML page that guides the user through BYU CAS + Duo login,
 * then captures cookies via the bookmarklet. Once cookies arrive, the
 * page auto-redirects to claude.ai with an authorization code.
 *
 * This server acts as both the Authorization Server and Resource Server.
 */

import { randomUUID, randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getUser } from "../sessions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OAUTH_STATE_FILE = resolve(__dirname, "../../oauth-state.json");

const FLOW_TTL_MS = 10 * 60 * 1000;      // 10 minutes for pending flows + auth codes
const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — BYU session kept alive by server pings

// --- Persistence ---

function loadState() {
  try {
    if (existsSync(OAUTH_STATE_FILE)) {
      return JSON.parse(readFileSync(OAUTH_STATE_FILE, "utf-8"));
    }
  } catch (err) {
    console.log(`[OAUTH] Could not load state: ${err.message}`);
  }
  return { clients: {}, accessTokens: {} };
}

function saveState(clients, accessTokens) {
  try {
    writeFileSync(OAUTH_STATE_FILE, JSON.stringify({
      clients: Object.fromEntries(clients),
      accessTokens: Object.fromEntries(accessTokens),
    }, null, 2));
  } catch (err) {
    console.log(`[OAUTH] Could not save state: ${err.message}`);
  }
}

let saveTimer = null;
function debouncedSave(clients, accessTokens) {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveState(clients, accessTokens);
  }, 5000);
}

// --- Clients Store ---

class ClientsStore {
  constructor() {
    this.clients = new Map();
  }

  async getClient(clientId) {
    return this.clients.get(clientId);
  }

  async registerClient(clientMetadata) {
    const clientId = randomUUID();
    const client = {
      ...clientMetadata,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(clientId, client);
    return client;
  }
}

// --- Provider ---

export class BYUOAuthProvider {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.clientsStore = new ClientsStore();
    this.pendingFlows = new Map();   // flowId -> { clientId, params, authCode, createdAt }
    this.authCodes = new Map();      // code -> { clientId, codeChallenge, sessionToken, createdAt }
    this.accessTokens = new Map();   // token -> { clientId, scopes, expiresAt, sessionToken }

    // Load persisted state
    const saved = loadState();
    if (saved.clients) {
      for (const [id, data] of Object.entries(saved.clients)) {
        this.clientsStore.clients.set(id, data);
      }
      console.log(`[OAUTH] Loaded ${this.clientsStore.clients.size} client(s)`);
    }
    if (saved.accessTokens) {
      const now = Date.now();
      for (const [token, data] of Object.entries(saved.accessTokens)) {
        if (data.expiresAt > now) {
          this.accessTokens.set(token, data);
        }
      }
      console.log(`[OAUTH] Loaded ${this.accessTokens.size} access token(s)`);
    }

    // Cleanup expired entries every 5 minutes
    setInterval(() => this._cleanup(), 5 * 60 * 1000);
  }

  _cleanup() {
    const now = Date.now();
    for (const [id, flow] of this.pendingFlows) {
      if (now - flow.createdAt > FLOW_TTL_MS) this.pendingFlows.delete(id);
    }
    for (const [code, data] of this.authCodes) {
      if (now - data.createdAt > FLOW_TTL_MS) this.authCodes.delete(code);
    }
    let expired = 0;
    for (const [token, data] of this.accessTokens) {
      if (data.expiresAt < now) {
        this.accessTokens.delete(token);
        expired++;
      }
    }
    if (expired > 0) {
      debouncedSave(this.clientsStore.clients, this.accessTokens);
    }
  }

  // --- OAuthServerProvider interface ---

  async authorize(client, params, res) {
    const flowId = randomUUID();

    this.pendingFlows.set(flowId, {
      clientId: client.client_id,
      params: {
        state: params.state,
        scopes: params.scopes,
        codeChallenge: params.codeChallenge,
        redirectUri: params.redirectUri,
        resource: params.resource,
      },
      authCode: null,
      createdAt: Date.now(),
    });

    console.log(`[OAUTH] Authorize flow started: ${flowId.slice(0, 8)}...`);

    const serverBase = this.serverUrl.href.replace(/\/$/, "");
    const bookmarkletHref = `javascript:void(document.head.appendChild(document.createElement('script')).src='${serverBase}/bookmarklet.js?flow=${flowId}&t='+Date.now())`;

    res.send(buildAuthorizePage(flowId, serverBase, bookmarkletHref));
  }

  async challengeForAuthorizationCode(_client, authorizationCode) {
    const data = this.authCodes.get(authorizationCode);
    if (!data) throw new Error("Invalid authorization code");
    return data.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, _redirectUri, _resource) {
    const data = this.authCodes.get(authorizationCode);
    if (!data) throw new Error("Invalid authorization code");
    if (data.clientId !== client.client_id) {
      throw new Error("Authorization code was not issued to this client");
    }

    // One-time use
    this.authCodes.delete(authorizationCode);

    // The session token from sessions.js IS the access token
    // This way, verifyAccessToken can check the session directly
    const accessToken = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + ACCESS_TOKEN_TTL_MS;

    this.accessTokens.set(accessToken, {
      clientId: client.client_id,
      scopes: data.scopes || [],
      expiresAt,
      sessionToken: data.sessionToken,
    });

    debouncedSave(this.clientsStore.clients, this.accessTokens);

    console.log(`[OAUTH] Token issued for session ${data.sessionToken.slice(0, 8)}...`);

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), // 30 days
    };
  }

  async exchangeRefreshToken() {
    throw new Error("Refresh tokens are not supported. Re-authenticate to get a new token.");
  }

  async verifyAccessToken(token) {
    const data = this.accessTokens.get(token);
    if (!data) throw new Error("Invalid access token");
    if (data.expiresAt < Date.now()) {
      this.accessTokens.delete(token);
      throw new Error("Access token expired");
    }

    // Verify the underlying BYU session is still alive
    const session = getUser(data.sessionToken);
    if (!session) {
      this.accessTokens.delete(token);
      throw new Error("BYU Learning Suite session has expired");
    }

    return {
      token,
      clientId: data.clientId,
      scopes: data.scopes,
      expiresAt: Math.floor(data.expiresAt / 1000),
    };
  }

  // --- Flow management (called by remote.js) ---

  /**
   * Called when /auth/register receives cookies with a flowId.
   * Links the session token to the pending OAuth flow.
   */
  completeFlow(flowId, sessionToken) {
    const flow = this.pendingFlows.get(flowId);
    if (!flow) return false;
    if (Date.now() - flow.createdAt > FLOW_TTL_MS) {
      this.pendingFlows.delete(flowId);
      return false;
    }

    const code = randomUUID();
    this.authCodes.set(code, {
      clientId: flow.clientId,
      codeChallenge: flow.params.codeChallenge,
      sessionToken,
      scopes: flow.params.scopes,
      createdAt: Date.now(),
    });

    flow.authCode = code;
    console.log(`[OAUTH] Flow ${flowId.slice(0, 8)}... completed`);
    return true;
  }

  /**
   * Called by /auth/flow-status/:flowId endpoint.
   * Returns { status, redirectUrl? }
   */
  getFlowStatus(flowId) {
    const flow = this.pendingFlows.get(flowId);
    if (!flow) return { status: "expired" };
    if (Date.now() - flow.createdAt > FLOW_TTL_MS) {
      this.pendingFlows.delete(flowId);
      return { status: "expired" };
    }

    if (!flow.authCode) return { status: "waiting" };

    // Build redirect URL
    const url = new URL(flow.params.redirectUri);
    url.searchParams.set("code", flow.authCode);
    if (flow.params.state) {
      url.searchParams.set("state", flow.params.state);
    }

    return { status: "ready", redirectUrl: url.href };
  }

  /**
   * Returns the session token linked to an access token.
   */
  getSessionTokenForAccessToken(accessToken) {
    const data = this.accessTokens.get(accessToken);
    return data ? data.sessionToken : null;
  }
}

// --- Authorize Page HTML ---

function buildAuthorizePage(flowId, serverBase, bookmarkletHref) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect to Claude</title>
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
  .page { max-width: 560px; margin: 0 auto; padding: 60px 32px; }

  h1 {
    font-family: 'Playfair Display', serif;
    font-weight: 900;
    font-size: clamp(36px, 8vw, 56px);
    color: #ffffff;
    line-height: 0.95;
    letter-spacing: -1px;
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  .tagline {
    font-size: 12px;
    color: #555;
    letter-spacing: 2px;
    text-transform: uppercase;
    margin-bottom: 48px;
  }
  .divider {
    width: 100%;
    height: 1px;
    background: #222;
    margin: 32px 0;
  }

  .step {
    display: grid;
    grid-template-columns: 36px 1fr;
    gap: 14px;
    margin-bottom: 32px;
    align-items: start;
  }
  .step-num {
    font-family: 'Playfair Display', serif;
    font-size: 28px;
    font-weight: 900;
    color: #333;
    line-height: 1;
  }
  .step h3 {
    font-size: 13px;
    font-weight: 700;
    color: #fff;
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 1px;
  }
  .step p {
    font-size: 12px;
    line-height: 1.7;
    color: #666;
  }
  .step a { color: #888; text-decoration: underline; text-underline-offset: 3px; }
  .step a:hover { color: #fff; }

  .drag-zone {
    text-align: center;
    margin: 32px 0;
    padding: 32px 24px;
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
    font-size: 18px;
    color: #333;
    margin-bottom: 16px;
    animation: float 2s ease-in-out infinite;
  }
  @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }

  .bookmarklet-btn {
    display: inline-block;
    padding: 14px 32px;
    background: #fff;
    color: #0a0a0a;
    font-family: 'Playfair Display', serif;
    font-size: 16px;
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

  /* Status */
  .status {
    text-align: center;
    padding: 24px;
    border: 1px solid #1a1a1a;
    margin-top: 32px;
  }
  .status-text {
    font-size: 11px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: #555;
  }
  .status-text.waiting { color: #666; }
  .status-text.connected { color: #4ade80; }
  .status-text.error { color: #f87171; }
  .status-text.timeout { color: #eab308; }

  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .pulsing { animation: pulse 2s ease-in-out infinite; }

  .retry-btn {
    margin-top: 16px;
    padding: 10px 24px;
    border: 1px solid #333;
    background: transparent;
    color: #888;
    font-family: 'Space Mono', monospace;
    font-size: 11px;
    letter-spacing: 2px;
    text-transform: uppercase;
    cursor: pointer;
    display: none;
  }
  .retry-btn:hover { border-color: #555; color: #fff; }
</style>
</head>
<body>
<div class="page">
  <h1>Connect<br>/ Claude</h1>
  <div class="tagline">Link your BYU Learning Suite</div>

  <div class="divider"></div>

  <div class="step">
    <div class="step-num">1</div>
    <div>
      <h3>Log into Learning Suite</h3>
      <p>Open <a href="https://learningsuite.byu.edu" target="_blank" rel="noopener">learningsuite.byu.edu</a> in another tab. Make sure you can see your courses.</p>
    </div>
  </div>

  <div class="step">
    <div class="step-num">2</div>
    <div>
      <h3>Click the bookmark on the LS page</h3>
      <p>Drag the button below to your bookmarks bar (one-time setup). Then switch to the Learning Suite tab and click it.</p>
    </div>
  </div>

  <div class="drag-zone">
    <span class="arrow">&uarr;</span>
    <a class="bookmarklet-btn" href="${bookmarkletHref}">Connect to Claude</a>
  </div>

  <div class="status" id="status">
    <div class="status-text waiting pulsing" id="statusText">Waiting for connection...</div>
    <button class="retry-btn" id="retryBtn" onclick="location.reload()">Try Again</button>
  </div>
</div>

<script>
(function() {
  var flowId = "${flowId}";
  var pollInterval = 2000;
  var maxWait = 10 * 60 * 1000;
  var startTime = Date.now();

  function poll() {
    if (Date.now() - startTime > maxWait) {
      document.getElementById("statusText").textContent = "Connection timed out";
      document.getElementById("statusText").className = "status-text timeout";
      document.getElementById("retryBtn").style.display = "inline-block";
      return;
    }

    fetch("/auth/flow-status/" + flowId)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.status === "ready") {
          document.getElementById("statusText").textContent = "Connected! Redirecting...";
          document.getElementById("statusText").className = "status-text connected";
          setTimeout(function() {
            window.location.href = data.redirectUrl;
          }, 1000);
        } else if (data.status === "expired") {
          document.getElementById("statusText").textContent = "Session expired";
          document.getElementById("statusText").className = "status-text error";
          document.getElementById("retryBtn").style.display = "inline-block";
        } else {
          setTimeout(poll, pollInterval);
        }
      })
      .catch(function() {
        setTimeout(poll, pollInterval);
      });
  }

  setTimeout(poll, pollInterval);
})();
</script>
</body>
</html>`;
}
