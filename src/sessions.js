// File-backed session store. Sessions persist across Node process restarts
// (same container) and are resilient to Railway deploys via the Chrome extension
// auto-refresh that re-registers within seconds of a restart.

import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_FILE = resolve(__dirname, "../sessions.json");
const SESSIONS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — matches OAuth access token lifetime

// Load sessions from disk on startup
const sessions = new Map();

function loadFromDisk() {
  try {
    if (existsSync(SESSIONS_FILE)) {
      const raw = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
      const now = Date.now();
      for (const [token, data] of Object.entries(raw)) {
        const age = now - new Date(data.registeredAt).getTime();
        if (age < SESSIONS_TTL_MS) {
          sessions.set(token, data);
        }
      }
      console.log(`[SESSIONS] Loaded ${sessions.size} session(s) from disk`);
    }
  } catch (err) {
    console.log(`[SESSIONS] Could not load sessions file: ${err.message}`);
  }
}

function saveToDisk() {
  try {
    const obj = Object.fromEntries(sessions);
    writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.log(`[SESSIONS] Could not save sessions file: ${err.message}`);
  }
}

// Debounce disk writes (at most once per 5 seconds)
let saveTimer = null;
function debouncedSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveToDisk();
  }, 5000);
}

// Load existing sessions on module init
loadFromDisk();

export function generateToken() {
  return randomBytes(24).toString("base64url");
}

export function registerUser(token, authState) {
  sessions.set(token, {
    cookies: authState.cookies,
    sessionCode: authState.sessionCode,
    registeredAt: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
    lastRefresh: new Date().toISOString(),
  });
  debouncedSave();
}

/**
 * Update an existing session's cookies and session code.
 * Called by the Chrome extension background heartbeat or bookmarklet re-click.
 */
export function updateUserCookies(token, cookies, sessionCode) {
  const user = sessions.get(token);
  if (!user) return false;
  user.cookies = cookies;
  user.sessionCode = sessionCode;
  user.lastUsed = new Date().toISOString();
  user.lastRefresh = new Date().toISOString();
  debouncedSave();
  return true;
}

export function getUser(token) {
  const user = sessions.get(token);
  if (!user) return null;

  // Expire sessions older than TTL
  const age = Date.now() - new Date(user.registeredAt).getTime();
  if (age > SESSIONS_TTL_MS) {
    sessions.delete(token);
    debouncedSave();
    return null;
  }

  user.lastUsed = new Date().toISOString();
  return user;
}

export function revokeUser(token) {
  const removed = sessions.delete(token);
  if (removed) debouncedSave();
  return removed;
}

export function listUsers() {
  return [...sessions.entries()].map(([token, data]) => ({
    token: token.slice(0, 8) + "...",
    registeredAt: data.registeredAt,
    lastUsed: data.lastUsed,
    lastRefresh: data.lastRefresh,
  }));
}

/**
 * Returns all active session tokens. Used on server startup
 * to restart keep-alive pings for persisted sessions.
 */
export function getAllTokens() {
  return [...sessions.keys()];
}

export { sessions as _sessions };
