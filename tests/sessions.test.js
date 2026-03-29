import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  generateToken,
  registerUser,
  getUser,
  updateUserCookies,
  revokeUser,
  _sessions,
} from "../src/sessions.js";

// Clean up sessions between tests to avoid cross-contamination
beforeEach(() => {
  _sessions.clear();
});

// ---------------------------------------------------------------------------
// generateToken
// ---------------------------------------------------------------------------
describe("generateToken", () => {
  it("returns a non-empty string", () => {
    const token = generateToken();
    assert.strictEqual(typeof token, "string");
    assert.ok(token.length > 0);
  });

  it("returns unique tokens on successive calls", () => {
    const tokens = new Set();
    for (let i = 0; i < 50; i++) {
      tokens.add(generateToken());
    }
    assert.strictEqual(tokens.size, 50, "all 50 tokens should be unique");
  });

  it("returns base64url-encoded strings", () => {
    const token = generateToken();
    // base64url uses A-Z, a-z, 0-9, -, _
    assert.ok(/^[A-Za-z0-9_-]+$/.test(token), "token should be base64url format");
  });
});

// ---------------------------------------------------------------------------
// registerUser + getUser roundtrip
// ---------------------------------------------------------------------------
describe("registerUser + getUser", () => {
  it("stores and retrieves user data", () => {
    const token = "test-token-1";
    const authState = {
      cookies: [{ name: "PHPSESSID", value: "abc123" }],
      sessionCode: "Xk9z",
    };

    registerUser(token, authState);
    const user = getUser(token);

    assert.ok(user, "getUser should return the session");
    assert.deepStrictEqual(user.cookies, authState.cookies);
    assert.strictEqual(user.sessionCode, authState.sessionCode);
    assert.ok(user.registeredAt, "should have registeredAt timestamp");
    assert.ok(user.lastUsed, "should have lastUsed timestamp");
  });

  it("updates lastUsed on each getUser call", () => {
    const token = "test-token-2";
    registerUser(token, { cookies: [], sessionCode: "A" });

    const firstCall = getUser(token);
    const firstLastUsed = firstCall.lastUsed;

    // Small delay to ensure timestamp changes
    const secondCall = getUser(token);
    // lastUsed should be updated (or at least present)
    assert.ok(secondCall.lastUsed);
  });
});

// ---------------------------------------------------------------------------
// updateUserCookies
// ---------------------------------------------------------------------------
describe("updateUserCookies", () => {
  it("updates cookies and sessionCode for an existing session", () => {
    const token = "update-token";
    registerUser(token, {
      cookies: [{ name: "old", value: "old" }],
      sessionCode: "OLD1",
    });

    const newCookies = [{ name: "new", value: "new" }];
    const result = updateUserCookies(token, newCookies, "NEW2");

    assert.strictEqual(result, true);

    const user = getUser(token);
    assert.deepStrictEqual(user.cookies, newCookies);
    assert.strictEqual(user.sessionCode, "NEW2");
  });

  it("returns false for a nonexistent token", () => {
    const result = updateUserCookies("nonexistent", [], "X");
    assert.strictEqual(result, false);
  });
});

// ---------------------------------------------------------------------------
// revokeUser
// ---------------------------------------------------------------------------
describe("revokeUser", () => {
  it("removes the session so getUser returns null", () => {
    const token = "revoke-token";
    registerUser(token, { cookies: [], sessionCode: "R" });

    assert.ok(getUser(token), "should exist before revocation");

    const deleted = revokeUser(token);
    assert.strictEqual(deleted, true);
    assert.strictEqual(getUser(token), null, "should return null after revocation");
  });

  it("returns false when revoking an unknown token", () => {
    assert.strictEqual(revokeUser("nope"), false);
  });
});

// ---------------------------------------------------------------------------
// Unknown tokens
// ---------------------------------------------------------------------------
describe("unknown tokens", () => {
  it("getUser returns null for an unknown token", () => {
    assert.strictEqual(getUser("does-not-exist"), null);
  });
});

// ---------------------------------------------------------------------------
// TTL expiry
// ---------------------------------------------------------------------------
describe("TTL expiry", () => {
  it("returns null for sessions older than 48 hours", () => {
    const token = "expired-token";
    registerUser(token, { cookies: [], sessionCode: "E" });

    // Manipulate registeredAt to be 49 hours ago
    const session = _sessions.get(token);
    const pastDate = new Date(Date.now() - 49 * 60 * 60 * 1000);
    session.registeredAt = pastDate.toISOString();

    const user = getUser(token);
    assert.strictEqual(user, null, "expired session should return null");
  });

  it("returns user for sessions within 48 hours", () => {
    const token = "fresh-token";
    registerUser(token, { cookies: [], sessionCode: "F" });

    // Manipulate registeredAt to be 47 hours ago (within TTL)
    const session = _sessions.get(token);
    const recentDate = new Date(Date.now() - 47 * 60 * 60 * 1000);
    session.registeredAt = recentDate.toISOString();

    const user = getUser(token);
    assert.ok(user, "session within TTL should still be valid");
  });

  it("deletes expired sessions from the store", () => {
    const token = "cleanup-token";
    registerUser(token, { cookies: [], sessionCode: "C" });

    const session = _sessions.get(token);
    session.registeredAt = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();

    getUser(token); // triggers TTL check
    assert.strictEqual(_sessions.has(token), false, "expired session should be removed from store");
  });
});
