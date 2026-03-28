/**
 * User session storage for the remote MCP server.
 * Each user has a unique token mapped to their BYU LS cookies.
 *
 * For production, swap this for Redis or SQLite.
 */

import { randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_PATH = resolve(__dirname, "../sessions.json");

let sessions = new Map();

// Load persisted sessions on startup
if (existsSync(SESSIONS_PATH)) {
  try {
    const data = JSON.parse(readFileSync(SESSIONS_PATH, "utf-8"));
    sessions = new Map(Object.entries(data));
  } catch {}
}

function persist() {
  const obj = Object.fromEntries(sessions);
  writeFileSync(SESSIONS_PATH, JSON.stringify(obj, null, 2));
}

export function generateToken() {
  return randomBytes(24).toString("base64url");
}

export function registerUser(token, authState) {
  sessions.set(token, {
    cookies: authState.cookies,
    sessionCode: authState.sessionCode,
    registeredAt: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
  });
  persist();
}

export function getUser(token) {
  const user = sessions.get(token);
  if (user) {
    user.lastUsed = new Date().toISOString();
    persist();
  }
  return user || null;
}

export function removeUser(token) {
  sessions.delete(token);
  persist();
}

export function listUsers() {
  return [...sessions.entries()].map(([token, data]) => ({
    token: token.slice(0, 8) + "...",
    registeredAt: data.registeredAt,
    lastUsed: data.lastUsed,
  }));
}
