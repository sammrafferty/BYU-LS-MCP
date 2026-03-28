// In-memory session store. Sessions survive within a deploy but are lost on container restart.
// For durable storage, add Redis or a Railway volume.

import { randomBytes } from "crypto";

const SESSIONS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
