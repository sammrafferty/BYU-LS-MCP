import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const AUTH_STATE_PATH = resolve(__dirname, "../../auth-state.json");

export function isAuthAvailable() {
  if (!existsSync(AUTH_STATE_PATH)) return false;
  try {
    const state = JSON.parse(readFileSync(AUTH_STATE_PATH, "utf-8"));
    return Array.isArray(state.cookies) && typeof state.sessionCode === "string";
  } catch {
    return false;
  }
}

export function loadAuthState() {
  if (!existsSync(AUTH_STATE_PATH)) {
    throw new Error(
      "No auth-state.json found. Run 'npm run auth' to log in to BYU Learning Suite."
    );
  }
  const state = JSON.parse(readFileSync(AUTH_STATE_PATH, "utf-8"));
  if (!Array.isArray(state.cookies) || !state.sessionCode) {
    throw new Error(
      "auth-state.json is malformed. Delete it and run 'npm run auth' again."
    );
  }
  return {
    cookies: state.cookies,
    sessionCode: state.sessionCode,
  };
}
