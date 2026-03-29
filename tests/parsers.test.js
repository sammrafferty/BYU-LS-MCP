import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadFixture } from "./helpers.js";
import {
  parseCourseList,
  parseGradebook,
  parseGradeSummary,
  parseAllAnnouncements,
  parseGlobalSchedule,
  parseCourseExams,
  parseCourseContent,
  parseUniversityCalendar,
  parseGroupMembers,
  parseSyllabusLink,
  extractJSONAfter,
  stripHtml,
} from "../src/scraper/parsers.js";
import { ParseError } from "../src/scraper/errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, "../debug");

function fixtureExists(name) {
  const p = resolve(FIXTURE_DIR, name);
  return existsSync(p) && require("fs").statSync(p).size > 0;
}

// ---------------------------------------------------------------------------
// extractJSONAfter  (synthetic HTML, edge cases)
// ---------------------------------------------------------------------------
describe("extractJSONAfter", () => {
  it("extracts a simple JSON array after a prefix", () => {
    const html = 'var items = [1,2,3]; // rest';
    const result = extractJSONAfter(html, "var items = ");
    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  it("extracts a simple JSON object after a prefix", () => {
    const html = 'config.set({"a":1,"b":2});';
    const result = extractJSONAfter(html, "config.set(");
    assert.deepStrictEqual(result, { a: 1, b: 2 });
  });

  it("handles nested brackets correctly", () => {
    const html = 'data = [{"arr":[1,[2,3]],"obj":{"k":"v"}}];';
    const result = extractJSONAfter(html, "data = ");
    assert.deepStrictEqual(result, [{ arr: [1, [2, 3]], obj: { k: "v" } }]);
  });

  it("handles escaped quotes inside strings", () => {
    const html = 'val = {"msg":"he said \\"hello\\""};';
    const result = extractJSONAfter(html, "val = ");
    assert.deepStrictEqual(result, { msg: 'he said "hello"' });
  });

  it("handles strings with brackets inside them", () => {
    const html = 'val = {"text":"some [braces] and {curly}"};';
    const result = extractJSONAfter(html, "val = ");
    assert.deepStrictEqual(result, { text: "some [braces] and {curly}" });
  });

  it("returns null when prefix is missing", () => {
    const html = "<html>no data here</html>";
    const result = extractJSONAfter(html, "missing_prefix = ");
    assert.strictEqual(result, null);
  });

  it("returns null when character after prefix is not [ or {", () => {
    const html = 'data = "not json";';
    const result = extractJSONAfter(html, "data = ");
    assert.strictEqual(result, null);
  });

  it("returns null for unbalanced brackets", () => {
    const html = "data = [{broken";
    const result = extractJSONAfter(html, "data = ");
    assert.strictEqual(result, null);
  });

  it("handles empty arrays", () => {
    const result = extractJSONAfter("instance.exams = [];", "instance.exams = ");
    assert.deepStrictEqual(result, []);
  });

  it("handles empty objects", () => {
    const result = extractJSONAfter("config.set({});", "config.set(");
    assert.deepStrictEqual(result, {});
  });
});

// ---------------------------------------------------------------------------
// stripHtml
// ---------------------------------------------------------------------------
describe("stripHtml", () => {
  it("strips HTML tags", () => {
    assert.strictEqual(stripHtml("<p>Hello <b>world</b></p>"), "Hello world");
  });

  it("converts <br> to newlines", () => {
    const result = stripHtml("line1<br>line2<br/>line3<BR />line4");
    assert.strictEqual(result, "line1\nline2\nline3\nline4");
  });

  it("converts </p> to newlines", () => {
    const result = stripHtml("<p>para1</p><p>para2</p>");
    assert.strictEqual(result, "para1\npara2");
  });

  it("decodes &nbsp;", () => {
    assert.strictEqual(stripHtml("hello&nbsp;world"), "hello world");
  });

  it("decodes &amp;", () => {
    assert.strictEqual(stripHtml("A&amp;B"), "A&B");
  });

  it("decodes &lt; and &gt;", () => {
    assert.strictEqual(stripHtml("&lt;div&gt;"), "<div>");
  });

  it("decodes &quot;", () => {
    assert.strictEqual(stripHtml('&quot;quoted&quot;'), '"quoted"');
  });

  it("decodes &#39;", () => {
    assert.strictEqual(stripHtml("it&#39;s"), "it's");
  });

  it("collapses excessive newlines to double newlines", () => {
    assert.strictEqual(stripHtml("a\n\n\n\n\nb"), "a\n\nb");
  });

  it("trims leading and trailing whitespace", () => {
    assert.strictEqual(stripHtml("  <p>hello</p>  "), "hello");
  });

  it("handles empty string", () => {
    assert.strictEqual(stripHtml(""), "");
  });
});

// ---------------------------------------------------------------------------
// parseCourseList  (dashboard.html)
// ---------------------------------------------------------------------------
describe("parseCourseList", () => {
  const fixture = "dashboard.html";
  const exists = existsSync(resolve(FIXTURE_DIR, fixture));

  (exists ? it : test.skip)("parses courses from the dashboard fixture", () => {
    const html = loadFixture(fixture);
    const courses = parseCourseList(html);

    assert.ok(Array.isArray(courses), "should return an array");
    assert.ok(courses.length >= 2, "should have at least 2 courses");

    // Every course should have the expected shape
    for (const c of courses) {
      assert.ok(c.courseId, `courseId should be truthy: ${JSON.stringify(c)}`);
      assert.ok(c.fullTitle, `fullTitle should be truthy: ${JSON.stringify(c)}`);
    }

    // Spot-check known courses
    const fin401 = courses.find((c) => c.courseCode === "FIN 401");
    assert.ok(fin401, "should contain FIN 401");
    assert.strictEqual(fin401.courseId, "3w_iiyj5-k6S");
    assert.strictEqual(fin401.courseName, "Adv Financial Management");

    const fin411 = courses.find((c) => c.courseCode === "FIN 411");
    assert.ok(fin411, "should contain FIN 411");
    assert.strictEqual(fin411.courseId, "Uzhp-UmvPZA5");
  });

  it("throws ParseError on empty HTML", () => {
    assert.throws(
      () => parseCourseList("<html></html>"),
      (err) => err instanceof ParseError
    );
  });

  it("throws ParseError when initialCourseGroups has empty courseGroups", () => {
    const html = 'initialCourseGroups = {"status":"OK","data":{"courseGroups":[{"periodName":"W26","courseList":[]}]}}';
    assert.throws(
      () => parseCourseList(html),
      (err) => err instanceof ParseError
    );
  });
});

// ---------------------------------------------------------------------------
// parseGradebook  (gradebook fixtures)
// ---------------------------------------------------------------------------
describe("parseGradebook", () => {
  const fixtureA = "3w_iiyj5-k6S-gradebook.html";
  const fixtureB = "Uzhp-UmvPZA5-gradebook.html";
  const existsA = existsSync(resolve(FIXTURE_DIR, fixtureA));
  const existsB = existsSync(resolve(FIXTURE_DIR, fixtureB));

  (existsA ? it : test.skip)("parses gradebook from FIN 401 fixture", () => {
    const html = loadFixture(fixtureA);
    const gb = parseGradebook(html);

    assert.ok(gb.categories.length > 0, "should have categories");
    assert.ok(gb.assignmentScores.length > 0, "should have assignment scores");

    // currentPercentage should be a number or null
    if (gb.currentPercentage !== null) {
      assert.strictEqual(typeof gb.currentPercentage, "number");
      assert.ok(gb.currentPercentage >= 0 && gb.currentPercentage <= 100,
        `percentage should be 0-100, got ${gb.currentPercentage}`);
    }

    // letterGrade should be a string or null
    if (gb.letterGrade !== null) {
      assert.strictEqual(typeof gb.letterGrade, "string");
    }

    // Each category should have expected fields
    for (const cat of gb.categories) {
      assert.ok("name" in cat, "category should have name");
      assert.ok("weight" in cat, "category should have weight");
      assert.ok("currentScore" in cat, "category should have currentScore");
    }

    // Raw data should be available
    assert.ok(Array.isArray(gb.rawAssignments));
    assert.ok(gb.rawScores instanceof Map);
  });

  (existsB ? it : test.skip)("parses gradebook from FIN 411 fixture", () => {
    const html = loadFixture(fixtureB);
    const gb = parseGradebook(html);

    assert.ok(gb.categories.length > 0, "should have categories");

    if (gb.currentPercentage !== null) {
      assert.strictEqual(typeof gb.currentPercentage, "number");
      assert.ok(gb.currentPercentage >= 0 && gb.currentPercentage <= 100);
    }
  });

  it("returns empty categories for HTML with no gradebook data", () => {
    const gb = parseGradebook("<html></html>");
    assert.deepStrictEqual(gb.categories, []);
    assert.deepStrictEqual(gb.assignmentScores, []);
    assert.strictEqual(gb.currentPercentage, null);
    assert.strictEqual(gb.letterGrade, null);
  });
});

// ---------------------------------------------------------------------------
// parseAllAnnouncements  (global-announcements.html)
// ---------------------------------------------------------------------------
describe("parseAllAnnouncements", () => {
  const fixture = "global-announcements.html";
  const exists = existsSync(resolve(FIXTURE_DIR, fixture));

  (exists ? it : test.skip)("parses announcements from fixture", () => {
    const html = loadFixture(fixture);
    const announcements = parseAllAnnouncements(html);

    assert.ok(Array.isArray(announcements), "should return an array");
    assert.ok(announcements.length > 0, "should have at least one announcement");

    for (const a of announcements) {
      assert.ok("title" in a, "should have title");
      assert.ok("body" in a, "should have body");
      assert.ok("postedDate" in a, "should have postedDate");
      // body should be stripped of HTML
      assert.ok(!a.body.includes("<p>"), "body should not contain raw <p> tags");
    }
  });

  it("throws ParseError on empty HTML", () => {
    assert.throws(
      () => parseAllAnnouncements("<html></html>"),
      (err) => err instanceof ParseError
    );
  });
});

// ---------------------------------------------------------------------------
// parseGlobalSchedule  (global-schedule.html)
// ---------------------------------------------------------------------------
describe("parseGlobalSchedule", () => {
  const fixture = "global-schedule.html";
  const exists = existsSync(resolve(FIXTURE_DIR, fixture));

  (exists ? it : test.skip)("parses schedule from fixture", () => {
    const html = loadFixture(fixture);
    const schedule = parseGlobalSchedule(html);

    assert.ok(Array.isArray(schedule), "should return an array");
    assert.ok(schedule.length >= 4, "should have at least 4 courses");

    // Spot-check known course
    const fin401 = schedule.find((s) => s.courseCode === "FIN 401");
    assert.ok(fin401, "should contain FIN 401");
    assert.strictEqual(fin401.courseId, "3w_iiyj5-k6S");
    assert.strictEqual(fin401.startTime, "2:00");
    assert.strictEqual(fin401.building, "TNRB");
    assert.strictEqual(fin401.room, "184");

    const is201 = schedule.find((s) => s.courseCode === "IS 201");
    assert.ok(is201, "should contain IS 201");
    assert.strictEqual(is201.startTime, "12:30");
    assert.strictEqual(is201.building, "TNRB");
    assert.strictEqual(is201.room, "251");
  });

  it("throws ParseError on empty HTML", () => {
    assert.throws(
      () => parseGlobalSchedule("<html></html>"),
      (err) => err instanceof ParseError
    );
  });
});

// ---------------------------------------------------------------------------
// parseUniversityCalendar  (global-schedule.html)
// ---------------------------------------------------------------------------
describe("parseUniversityCalendar", () => {
  const fixture = "global-schedule.html";
  const exists = existsSync(resolve(FIXTURE_DIR, fixture));

  (exists ? it : test.skip)("parses university calendar from fixture", () => {
    const html = loadFixture(fixture);
    const dates = parseUniversityCalendar(html);

    assert.ok(Array.isArray(dates), "should return an array");
    assert.ok(dates.length > 0, "should have at least one date");

    // Should be sorted by date
    for (let i = 1; i < dates.length; i++) {
      assert.ok(dates[i].date >= dates[i - 1].date, "dates should be sorted ascending");
    }

    // Each entry should have date and title
    for (const d of dates) {
      assert.ok("date" in d, "should have date");
      assert.ok("title" in d, "should have title");
      assert.ok(typeof d.date === "string");
      assert.ok(typeof d.title === "string");
    }

    // Spot-check known dates
    const startOfClasses = dates.find((d) => d.title === "Start of Classes");
    assert.ok(startOfClasses, "should include Start of Classes");
    assert.strictEqual(startOfClasses.date, "2026-01-07");
  });

  it("returns empty array when universityDates missing", () => {
    const dates = parseUniversityCalendar("<html></html>");
    assert.deepStrictEqual(dates, []);
  });
});

// ---------------------------------------------------------------------------
// parseCourseExams  (exams fixtures)
// ---------------------------------------------------------------------------
describe("parseCourseExams", () => {
  const fixtureEmpty = "3w_iiyj5-k6S-exams.html";
  const fixtureWithData = "Uzhp-UmvPZA5-exams.html";
  const existsEmpty = existsSync(resolve(FIXTURE_DIR, fixtureEmpty));
  const existsData = existsSync(resolve(FIXTURE_DIR, fixtureWithData));

  (existsEmpty ? it : test.skip)("returns empty array when instance.exams is empty", () => {
    const html = loadFixture(fixtureEmpty);
    const exams = parseCourseExams(html);
    assert.ok(Array.isArray(exams));
    assert.strictEqual(exams.length, 0);
  });

  (existsData ? it : test.skip)("parses exams from FIN 411 fixture", () => {
    const html = loadFixture(fixtureWithData);
    const exams = parseCourseExams(html);

    assert.ok(Array.isArray(exams));
    assert.ok(exams.length >= 2, "should have at least 2 exams");

    // Spot-check first exam
    const midterm = exams.find((e) => e.title.includes("First Midterm"));
    assert.ok(midterm, "should contain First Midterm");
    assert.strictEqual(midterm.status, "complete");
    assert.strictEqual(midterm.timesTaken, 1);
    assert.ok(midterm.startWindow);
    assert.ok(midterm.endWindow);
    assert.ok(midterm.examDate);

    // Second exam
    const second = exams.find((e) => e.title.includes("Second Midterm"));
    assert.ok(second, "should contain Second Midterm");
    assert.strictEqual(second.status, "incomplete");
    assert.strictEqual(second.timesTaken, 0);
  });

  it("returns empty array when exams data missing", () => {
    const exams = parseCourseExams("<html></html>");
    assert.deepStrictEqual(exams, []);
  });
});

// ---------------------------------------------------------------------------
// parseGroupMembers  (groups fixtures)
// ---------------------------------------------------------------------------
describe("parseGroupMembers", () => {
  const fixtureHrm = "groups-hrm391.html";
  const fixtureFin = "groups-fin401.html";
  const existsHrm = existsSync(resolve(FIXTURE_DIR, fixtureHrm));
  const existsFin = existsSync(resolve(FIXTURE_DIR, fixtureFin));

  (existsHrm ? it : test.skip)("parses groups and members from HRM 391 fixture", () => {
    const html = loadFixture(fixtureHrm);
    // Pass a known student ID that's in the group
    const groups = parseGroupMembers(html, "745295202");

    assert.ok(Array.isArray(groups));
    assert.ok(groups.length >= 1, "should find at least one group");

    const group = groups[0];
    assert.ok(group.groupName, "group should have a name");
    assert.ok(Array.isArray(group.members), "group should have members array");
    assert.ok(group.members.length > 0, "group should have at least one member");

    // Members should be resolved to names, not just IDs
    const samFound = group.members.some((m) => m.includes("Rafferty"));
    assert.ok(samFound, "should resolve Sam Rafferty's name");
  });

  (existsHrm ? it : test.skip)("returns all groups when studentId is null", () => {
    const html = loadFixture(fixtureHrm);
    const groups = parseGroupMembers(html, null);

    assert.ok(Array.isArray(groups));
    assert.ok(groups.length >= 1);
  });

  (existsFin ? it : test.skip)("returns empty array when no groups exist", () => {
    const html = loadFixture(fixtureFin);
    const groups = parseGroupMembers(html, "745295202");

    assert.ok(Array.isArray(groups));
    assert.strictEqual(groups.length, 0);
  });

  it("returns empty array on missing data", () => {
    const groups = parseGroupMembers("<html></html>", null);
    assert.deepStrictEqual(groups, []);
  });
});

// ---------------------------------------------------------------------------
// parseSyllabusLink  (syllabus fixture)
// ---------------------------------------------------------------------------
describe("parseSyllabusLink", () => {
  const fixture = "3w_iiyj5-k6S-syllabus.html";
  const filePath = resolve(FIXTURE_DIR, fixture);
  const exists = existsSync(filePath) && statSync(filePath).size > 0;

  (exists ? it : test.skip)("extracts syllabus file ID from fixture", () => {
    const html = loadFixture(fixture);
    const fileId = parseSyllabusLink(html);

    assert.ok(fileId, "should find a file ID");
    assert.strictEqual(typeof fileId, "string");
    assert.ok(fileId.length > 5, "file ID should be a non-trivial string");
  });

  it("returns null when no syllabus link exists", () => {
    assert.strictEqual(parseSyllabusLink("<html></html>"), null);
  });

  it("returns null for empty syllabus fixture", () => {
    // Uzhp-UmvPZA5-syllabus.html is 0 bytes
    assert.strictEqual(parseSyllabusLink(""), null);
  });
});

// ---------------------------------------------------------------------------
// parseCourseContent
// ---------------------------------------------------------------------------
describe("parseCourseContent", () => {
  it("returns empty array when no content data is found", () => {
    const result = parseCourseContent("<html></html>");
    assert.deepStrictEqual(result, []);
  });

  it("parses instance.pages when present", () => {
    const html = 'instance.pages = [{"title":"Lecture 1","url":"file.pdf","sectionTitle":"Week 1"}];';
    const result = parseCourseContent(html);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].title, "Lecture 1");
    assert.strictEqual(result[0].section, "Week 1");
  });

  it("falls back to instance.items", () => {
    const html = 'instance.items = [{"title":"Resource","url":"http://example.com"}];';
    const result = parseCourseContent(html);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].title, "Resource");
  });
});

// ---------------------------------------------------------------------------
// parseGradeSummary
// ---------------------------------------------------------------------------
describe("parseGradeSummary", () => {
  it("throws ParseError when courseData is missing", () => {
    assert.throws(
      () => parseGradeSummary("<html></html>"),
      (err) => err instanceof ParseError
    );
  });

  it("parses courseData when present", () => {
    const html = 'courseData: [{"name":"Course A","grade":"A"}];';
    const result = parseGradeSummary(html);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result[0].name, "Course A");
  });
});
