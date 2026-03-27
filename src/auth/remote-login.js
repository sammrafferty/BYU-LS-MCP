#!/usr/bin/env node

/**
 * Remote auth CLI — authenticates with BYU Learning Suite
 * and registers your session with the remote MCP server.
 *
 * Usage: npm run auth:remote
 *    or: npm run auth:remote -- --server https://yourserver.com
 */

import { chromium } from "playwright";

const DEFAULT_SERVER = process.env.BYU_LS_SERVER || "http://localhost:3847";
const LS_URL = "https://learningsuite.byu.edu";
const TIMEOUT_MS = 5 * 60 * 1000;

// Parse --server arg
const serverArg = process.argv.find((a) => a.startsWith("--server="));
const serverIdx = process.argv.indexOf("--server");
const SERVER_URL = serverArg
  ? serverArg.split("=")[1]
  : serverIdx !== -1
    ? process.argv[serverIdx + 1]
    : DEFAULT_SERVER;

async function remoteLogin() {
  console.log("=== BYU Learning Suite — Remote Auth ===\n");
  console.log(`Server: ${SERVER_URL}`);
  console.log("Opening browser — please log in with your BYU credentials.\n");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(LS_URL);

  try {
    await page.waitForURL(/learningsuite\.byu\.edu\/\.\w+\/student/, {
      timeout: TIMEOUT_MS,
    });
  } catch {
    console.error("\nLogin timed out. Please try again.");
    await browser.close();
    process.exit(1);
  }

  // Extract session code from URL
  const finalUrl = page.url();
  const match = finalUrl.match(/learningsuite\.byu\.edu\/\.(\w+)\//);
  if (!match) {
    console.error("Could not extract session code from URL:", finalUrl);
    await browser.close();
    process.exit(1);
  }

  const sessionCode = match[1];
  const storageState = await context.storageState();

  console.log(`\nLogin successful! Session code: ${sessionCode}`);
  console.log("Registering with remote server...\n");

  await browser.close();

  // POST cookies to remote server
  const res = await fetch(`${SERVER_URL}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cookies: storageState.cookies,
      sessionCode,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`Server registration failed: ${err}`);
    process.exit(1);
  }

  const data = await res.json();

  console.log("Registration complete!\n");
  console.log("━".repeat(60));
  console.log(`\n  Your connector URL:\n`);
  console.log(`  ${SERVER_URL}${data.mcpUrl}\n`);
  console.log("━".repeat(60));
  console.log(`\n  To connect Claude Desktop:`);
  console.log(`  1. Open Claude Desktop → Settings → Connectors`);
  console.log(`  2. Click + → Add custom connector`);
  console.log(`  3. Name: BYU Learning Suite`);
  console.log(`  4. URL: ${SERVER_URL}${data.mcpUrl}`);
  console.log(`  5. Click Add\n`);
  console.log(`  Your token (save this): ${data.token}\n`);
}

remoteLogin().catch((err) => {
  console.error("Auth failed:", err.message);
  process.exit(1);
});
