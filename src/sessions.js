// In-memory session store. Sessions survive within a deploy but are lost on container restart.
// Tokens are permanent per user — stored in localStorage on the LS domain.
// Clicking the bookmark again refreshes cookies behind the same token.

import { randomBytes } from "crypto";

const SESSIONS_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours (generous, keep-alive extends this)

const sessions = new Map();

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
}

/**
 * Update an existing session's cookies and session code.
 * Used when the bookmarklet is clicked again with the same token.
 */
export function updateUserCookies(token, cookies, sessionCode) {
  const user = sessions.get(token);
  if (!user) return false;
  user.cookies = cookies;
  user.sessionCode = sessionCode;
  user.lastUsed = new Date().toISOString();
  return true;
}

export function getUser(token) {
  const user = sessions.get(token);
  if (!user) return null;

  // Expire sessions older than TTL
  const age = Date.now() - new Date(user.registeredAt).getTime();
  if (age > SESSIONS_TTL_MS) {
    sessions.delete(token);
    return null;
  }

  user.lastUsed = new Date().toISOString();
  return user;
}

export function revokeUser(token) {
  return sessions.delete(token);
}

export function listUsers() {
  return [...sessions.entries()].map(([token, data]) => ({
    token: token.slice(0, 8) + "...",
    registeredAt: data.registeredAt,
    lastUsed: data.lastUsed,
  }));
}
