import { SessionExpiredError, ParseError } from "./errors.js";

export function wrapErrors(fn) {
  return async (params) => {
    try {
      return await fn(params);
    } catch (err) {
      if (err instanceof SessionExpiredError) return { error: err.message, errorCode: "SESSION_EXPIRED" };
      if (err instanceof ParseError) return { error: `Parse error: ${err.message}`, errorCode: "PARSE_ERROR" };
      if (err.name === "TimeoutError" || err.message?.includes("timed out")) return { error: "Request timed out. Try again.", errorCode: "TIMEOUT" };
      return { error: `Error: ${err.message}`, errorCode: "UNKNOWN" };
    }
  };
}
