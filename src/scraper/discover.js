#!/usr/bin/env node

/**
 * Discovery script — fetches real LS pages and saves raw HTML to debug/.
 * Run after `npm run auth` to inspect the actual page structure.
 *
 * Usage: npm run discover
 */

import { mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadAuthState } from "../auth/state.js";
import { createHttpClient } from "./http.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEBUG_DIR = resolve(__dirname, "../../debug");

function save(filename, content) {
  writeFileSync(resolve(DEBUG_DIR, filename), content);
  console.log(`  Saved: debug/${filename} (${content.length} bytes)`);
}

async function discover() {
  mkdirSync(DEBUG_DIR, { recursive: true });

  console.log("Loading auth state...\n");
  const authState = loadAuthState();
  const http = createHttpClient(authState);

  // 1. Fetch student dashboard (course list)
  console.log("Fetching student dashboard...");
  const dashboard = await http.get("student/top");
  save("dashboard.html", dashboard);

  // 2. Extract course IDs from dashboard
  const cidMatches = [...dashboard.matchAll(/cid-([A-Za-z0-9_-]+)/g)];
  const courseIds = [...new Set(cidMatches.map((m) => m[1]))];

  if (courseIds.length === 0) {
    console.log("\nNo course IDs found in dashboard HTML.");
    return;
  }

  console.log(`\nFound ${courseIds.length} course(s): ${courseIds.join(", ")}\n`);

  // 3. Fetch global overview pages
  console.log("Fetching global overview pages...");
  const globalPages = ["schedule", "summary", "announcements"];
  for (const page of globalPages) {
    try {
      const html = await http.get(`student/top/${page}`);
      save(`global-${page}.html`, html);
    } catch (err) {
      console.log(`  Skipped: student/top/${page} — ${err.message}`);
    }
  }

  // 4. For first 2 courses, fetch course-specific pages
  // Correct LS URL patterns:
  //   gradebook     → cid-{id}/student/gradebook  (has assignments, scores, categories)
  //   content       → cid-{id}/student/pages
  //   exams         → cid-{id}/student/exam
  //   schedule      → cid-{id}/student/calendar
  //   syllabus      → cid-{id}/student/syllabus
  //   home          → cid-{id}/student/home
  const coursePages = [
    { name: "gradebook", path: "gradebook" },
    { name: "content", path: "pages" },
    { name: "exams", path: "exam" },
    { name: "schedule", path: "calendar" },
    { name: "syllabus", path: "syllabus" },
    { name: "home", path: "home" },
  ];

  const coursesToScan = courseIds.slice(0, 2);
  for (const cid of coursesToScan) {
    console.log(`\nFetching pages for course ${cid}...`);
    for (const { name, path } of coursePages) {
      try {
        const html = await http.get(`cid-${cid}/student/${path}`);
        save(`${cid}-${name}.html`, html);
      } catch (err) {
        console.log(`  Skipped: ${name} — ${err.message}`);
      }
    }
  }

  console.log("\nDiscovery complete! Inspect the debug/ directory.");
}

discover().catch((err) => {
  console.error("Discovery failed:", err.message);
  process.exit(1);
});
