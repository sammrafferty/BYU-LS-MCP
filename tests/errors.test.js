import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionExpiredError, ParseError } from "../src/scraper/errors.js";
import { wrapErrors } from "../src/scraper/wrapErrors.js";

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------
describe("SessionExpiredError", () => {
  it("has name SessionExpiredError", () => {
    const err = new SessionExpiredError();
    assert.strictEqual(err.name, "SessionExpiredError");
  });

  it("has a descriptive message", () => {
    const err = new SessionExpiredError();
    assert.ok(err.message.includes("session has expired"));
  });

  it("is an instance of Error", () => {
    const err = new SessionExpiredError();
    assert.ok(err instanceof Error);
  });
});

describe("ParseError", () => {
  it("has name ParseError", () => {
    const err = new ParseError("gradebook", "missing data");
    assert.strictEqual(err.name, "ParseError");
  });

  it("includes page and detail in message", () => {
    const err = new ParseError("dashboard", "no courses");
    assert.ok(err.message.includes("dashboard"));
    assert.ok(err.message.includes("no courses"));
  });

  it("stores page as a property", () => {
    const err = new ParseError("schedule", "bad format");
    assert.strictEqual(err.page, "schedule");
  });

  it("is an instance of Error", () => {
    const err = new ParseError("test", "detail");
    assert.ok(err instanceof Error);
  });
});

// ---------------------------------------------------------------------------
// wrapErrors
// ---------------------------------------------------------------------------
describe("wrapErrors", () => {
  it("returns function result on success", async () => {
    const wrapped = wrapErrors(async () => ({ data: "ok" }));
    const result = await wrapped();
    assert.deepStrictEqual(result, { data: "ok" });
  });

  it("catches SessionExpiredError and returns error with SESSION_EXPIRED code", async () => {
    const wrapped = wrapErrors(async () => {
      throw new SessionExpiredError();
    });
    const result = await wrapped();

    assert.ok(result.error, "should have error message");
    assert.ok(result.error.includes("session has expired"));
    assert.strictEqual(result.errorCode, "SESSION_EXPIRED");
  });

  it("catches ParseError and returns error with PARSE_ERROR code", async () => {
    const wrapped = wrapErrors(async () => {
      throw new ParseError("gradebook", "missing categories");
    });
    const result = await wrapped();

    assert.ok(result.error);
    assert.ok(result.error.includes("Parse error"));
    assert.ok(result.error.includes("gradebook"));
    assert.strictEqual(result.errorCode, "PARSE_ERROR");
  });

  it("catches timeout errors and returns TIMEOUT code", async () => {
    const wrapped = wrapErrors(async () => {
      const err = new Error("The operation timed out");
      err.name = "TimeoutError";
      throw err;
    });
    const result = await wrapped();

    assert.ok(result.error);
    assert.ok(result.error.includes("timed out"));
    assert.strictEqual(result.errorCode, "TIMEOUT");
  });

  it("catches timeout via message content", async () => {
    const wrapped = wrapErrors(async () => {
      throw new Error("Request timed out after 15s");
    });
    const result = await wrapped();

    assert.ok(result.error);
    assert.strictEqual(result.errorCode, "TIMEOUT");
  });

  it("catches generic errors and returns UNKNOWN code", async () => {
    const wrapped = wrapErrors(async () => {
      throw new Error("something broke");
    });
    const result = await wrapped();

    assert.ok(result.error);
    assert.ok(result.error.includes("something broke"));
    assert.strictEqual(result.errorCode, "UNKNOWN");
  });

  it("passes params through to the wrapped function", async () => {
    const wrapped = wrapErrors(async (params) => {
      return { received: params };
    });
    const result = await wrapped({ course: "FIN 401" });
    assert.deepStrictEqual(result, { received: { course: "FIN 401" } });
  });
});
