#!/usr/bin/env node

import { chromium } from "playwright";
import { writeFileSync } from "fs";
import { AUTH_STATE_PATH } from "./state.js";

const LS_URL = "https://learningsuite.byu.edu";
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function login() {
  console.log("Opening browser — please log in with your BYU credentials.");
  console.log("This window will close automatically after login succeeds.\n");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(LS_URL);

  // Wait for redirect back to LS after CAS + Duo login.
  // The post-login URL looks like: learningsuite.byu.edu/.XXXX/student/top
  try {
    await page.waitForURL(/learningsuite\.byu\.edu\/\.\w+\/student/, {
      timeout: TIMEOUT_MS,
    });
  } catch {
    console.error("\nLogin timed out after 5 minutes. Please try again.");
    await browser.close();
    process.exit(1);
  }

  // Extract the 4-char session code from the URL
  const finalUrl = page.url();
  const match = finalUrl.match(/learningsuite\.byu\.edu\/\.(\w+)\//);
  if (!match) {
    console.error("Could not extract session code from URL:", finalUrl);
    await browser.close();
    process.exit(1);
  }
  const sessionCode = match[1];

  // Save full storage state (cookies + localStorage) plus our session code
  const storageState = await context.storageState();
  const authState = {
    ...storageState,
    sessionCode,
  };

  writeFileSync(AUTH_STATE_PATH, JSON.stringify(authState, null, 2));
  console.log(`\nLogin successful! Session code: ${sessionCode}`);
  console.log(`Auth state saved to: ${AUTH_STATE_PATH}`);

  await browser.close();
}

login().catch((err) => {
  console.error("Login failed:", err.message);
  process.exit(1);
});
