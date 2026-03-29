import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadFixture } from "./helpers.js";
import { recalculateGrade, lookupLetterGrade } from "../src/data/scraperAdapter.js";
import { parseGradebook } from "../src/scraper/parsers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, "../debug");

// ---------------------------------------------------------------------------
// recalculateGrade
// ---------------------------------------------------------------------------
describe("recalculateGrade", () => {
  it("computes percentage from simple point totals", () => {
    const assignments = [
      { id: "a1", graded: true, points: 100 },
      { id: "a2", graded: true, points: 50 },
    ];
    const categories = [{ name: "Homework", weight: 100 }];
    const scoreMap = new Map([
      ["a1", 90],
      ["a2", 45],
    ]);

    const result = recalculateGrade(assignments, categories, scoreMap);
    // 135 / 150 = 90%
    assert.strictEqual(result.percentage, 90);
  });

  it("returns null when no assignments have scores", () => {
    const assignments = [
      { id: "a1", graded: true, points: 100 },
    ];
    const categories = [{ name: "Cat", weight: 100 }];
    const scoreMap = new Map();

    const result = recalculateGrade(assignments, categories, scoreMap);
    assert.strictEqual(result.percentage, null);
  });

  it("ignores non-graded assignments", () => {
    const assignments = [
      { id: "a1", graded: true, points: 100 },
      { id: "a2", graded: false, points: 50 },
    ];
    const categories = [{ name: "Cat", weight: 100 }];
    const scoreMap = new Map([
      ["a1", 80],
      ["a2", 50], // should be ignored since a2 is not graded
    ]);

    const result = recalculateGrade(assignments, categories, scoreMap);
    assert.strictEqual(result.percentage, 80);
  });

  it("handles perfect score", () => {
    const assignments = [
      { id: "a1", graded: true, points: 200 },
    ];
    const categories = [{ name: "Cat", weight: 100 }];
    const scoreMap = new Map([["a1", 200]]);

    const result = recalculateGrade(assignments, categories, scoreMap);
    assert.strictEqual(result.percentage, 100);
  });

  it("handles zero score", () => {
    const assignments = [
      { id: "a1", graded: true, points: 100 },
    ];
    const categories = [{ name: "Cat", weight: 100 }];
    const scoreMap = new Map([["a1", 0]]);

    const result = recalculateGrade(assignments, categories, scoreMap);
    assert.strictEqual(result.percentage, 0);
  });

  it("handles multiple assignments with varying scores", () => {
    const assignments = [
      { id: "a1", graded: true, points: 100 },
      { id: "a2", graded: true, points: 100 },
      { id: "a3", graded: true, points: 100 },
    ];
    const categories = [{ name: "Cat", weight: 100 }];
    const scoreMap = new Map([
      ["a1", 100],
      ["a2", 50],
      ["a3", 75],
    ]);

    const result = recalculateGrade(assignments, categories, scoreMap);
    // 225 / 300 = 75%
    assert.strictEqual(result.percentage, 75);
  });
});

// ---------------------------------------------------------------------------
// lookupLetterGrade
// ---------------------------------------------------------------------------
describe("lookupLetterGrade", () => {
  const makeGb = (items) => ({
    _gradeScale: { items },
  });

  const standardScale = makeGb({
    "A": 93,
    "A-": 90,
    "B+": 87,
    "B": 83,
    "B-": 80,
    "C+": 77,
    "C": 73,
    "C-": 70,
    "D+": 67,
    "D": 63,
    "D-": 60,
    "E": 0,
  });

  it("returns A for percentage at exactly 93", () => {
    assert.strictEqual(lookupLetterGrade(93, standardScale), "A");
  });

  it("returns A for percentage above 93", () => {
    assert.strictEqual(lookupLetterGrade(98.5, standardScale), "A");
  });

  it("returns A- for percentage at exactly 90", () => {
    assert.strictEqual(lookupLetterGrade(90, standardScale), "A-");
  });

  it("returns A- for percentage between 90 and 93", () => {
    assert.strictEqual(lookupLetterGrade(91.5, standardScale), "A-");
  });

  it("returns B+ for percentage just below 90", () => {
    assert.strictEqual(lookupLetterGrade(89.9, standardScale), "B+");
  });

  it("returns E for percentage at 0", () => {
    assert.strictEqual(lookupLetterGrade(0, standardScale), "E");
  });

  it("returns E for very low percentage", () => {
    assert.strictEqual(lookupLetterGrade(15, standardScale), "E");
  });

  it("returns null when percentage is null", () => {
    assert.strictEqual(lookupLetterGrade(null, standardScale), null);
  });

  it("returns null when grade scale is missing", () => {
    assert.strictEqual(lookupLetterGrade(90, {}), null);
    assert.strictEqual(lookupLetterGrade(90, { _gradeScale: null }), null);
    assert.strictEqual(lookupLetterGrade(90, { _gradeScale: {} }), null);
  });

  it("handles grade scale with non-standard letters", () => {
    const gb = makeGb({ "Pass": 60, "Fail": 0 });
    assert.strictEqual(lookupLetterGrade(75, gb), "Pass");
    assert.strictEqual(lookupLetterGrade(59, gb), "Fail");
  });
});

// ---------------------------------------------------------------------------
// parseGradebook grade calculation (fixture-based integration)
// ---------------------------------------------------------------------------
describe("parseGradebook grade calculation", () => {
  const fixture = "3w_iiyj5-k6S-gradebook.html";
  const exists = existsSync(resolve(FIXTURE_DIR, fixture));

  (exists ? it : test.skip)("produces reasonable grade from FIN 401 fixture", () => {
    const html = loadFixture(fixture);
    const gb = parseGradebook(html);

    if (gb.currentPercentage !== null) {
      assert.strictEqual(typeof gb.currentPercentage, "number");
      assert.ok(
        gb.currentPercentage >= 0 && gb.currentPercentage <= 120,
        `currentPercentage should be 0-120 (allows extra credit), got ${gb.currentPercentage}`
      );
    }

    if (gb.letterGrade !== null) {
      assert.strictEqual(typeof gb.letterGrade, "string");
      assert.ok(gb.letterGrade.length <= 2, "letter grade should be 1-2 chars");
    }

    // Verify categories add up reasonably
    const totalWeight = gb.categories.reduce((sum, c) => sum + c.weight, 0);
    assert.ok(totalWeight > 0, "total category weight should be > 0");
  });

  const fixtureB = "Uzhp-UmvPZA5-gradebook.html";
  const existsB = existsSync(resolve(FIXTURE_DIR, fixtureB));

  (existsB ? it : test.skip)("produces reasonable grade from FIN 411 fixture", () => {
    const html = loadFixture(fixtureB);
    const gb = parseGradebook(html);

    if (gb.currentPercentage !== null) {
      assert.strictEqual(typeof gb.currentPercentage, "number");
      assert.ok(
        gb.currentPercentage >= 0 && gb.currentPercentage <= 120,
        `currentPercentage should be 0-120, got ${gb.currentPercentage}`
      );
    }
  });
});
