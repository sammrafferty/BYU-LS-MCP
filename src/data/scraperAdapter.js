import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadAuthState } from "../auth/state.js";
import { createHttpClient } from "../scraper/http.js";
import { SessionExpiredError, ParseError } from "../scraper/errors.js";
import { wrapErrors } from "../scraper/wrapErrors.js";
import { readFileSync, existsSync } from "fs";
import {
  parseCourseList,
  parseGradebook,
  parseAllAnnouncements,
  parseGlobalSchedule,
  parseCourseExams,
  parseCourseContent,
  parseUniversityCalendar,
  parseGroupMembers,
  parseSyllabusLink,
} from "../scraper/parsers.js";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function matchesCourse(item, courseFilter) {
  if (!courseFilter) return true;
  const filter = courseFilter.toLowerCase();
  return (
    (item.courseName && item.courseName.toLowerCase().includes(filter)) ||
    (item.courseCode && item.courseCode.toLowerCase().includes(filter))
  );
}

export async function createScraperDataSource(authStateOverride = null) {
  const authState = authStateOverride || loadAuthState();
  const http = createHttpClient(authState);

  const cache = new Map();

  function getCached(key) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
      return entry.data;
    }
    return null;
  }

  function setCache(key, data) {
    cache.set(key, { data, timestamp: Date.now() });
  }

  // Fetch and cache the course list from the dashboard
  async function getCourses() {
    const cached = getCached("courses");
    if (cached) return cached;
    const html = await http.get("student/top");
    const courses = parseCourseList(html);
    setCache("courses", courses);
    return courses;
  }

  // Fetch and cache gradebook for a specific course
  async function getGradebookData(course) {
    const key = `gradebook-${course.courseId}`;
    const cached = getCached(key);
    if (cached) return cached;
    const html = await http.get(`cid-${course.courseId}/student/gradebook`);
    const data = parseGradebook(html);
    setCache(key, data);
    return data;
  }

  return {
    getAssignments: wrapErrors(async ({ course, daysAhead = 14 } = {}) => {
      const now = new Date();
      const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
      const courses = await getCourses();
      const filtered = courses.filter((c) => matchesCourse(c, course));
      const results = [];
      const warnings = [];

      for (const c of filtered) {
        try {
          const gb = await getGradebookData(c);
          for (const a of gb.rawAssignments) {
            if (!a.dueDate) continue;
            // LS dates are in "YYYY-MM-DD HH:MM:SS" format (Mountain Time)
            const due = new Date(a.dueDate.replace(" ", "T") + "-07:00");
            if (due < now || due > cutoff) continue;

            const hasScore = gb.rawScores.has(a.id);
            const catInfo = gb.categories.find(
              (cat) =>
                cat.name ===
                (gb.assignmentScores.find((as) => as.title === a.name) || {}).category
            );

            results.push({
              courseName: c.courseName,
              title: a.name,
              dueDate: due.toISOString(),
              pointsPossible: a.points,
              status: hasScore ? "submitted" : "not submitted",
              category: inferAssignmentCategory(a, catInfo),
            });
          }
        } catch (err) {
          if (err instanceof SessionExpiredError) throw err;
          warnings.push(`Could not load ${c.courseName}: ${err.message}`);
        }
      }

      const sorted = results.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
      if (warnings.length > 0) {
        sorted._warnings = warnings;
      }
      return sorted;
    }),

    getGrades: wrapErrors(async ({ course } = {}) => {
      const courses = await getCourses();

      if (course) {
        const match = courses.find((c) => matchesCourse(c, course));
        if (!match) return { error: `No course found matching "${course}"` };

        const gb = await getGradebookData(match);
        return {
          courseName: match.courseName,
          courseCode: match.courseCode,
          currentPercentage: gb.currentPercentage,
          letterGrade: gb.letterGrade,
          categories: gb.categories,
          assignmentScores: gb.assignmentScores,
        };
      }

      const summaries = [];
      const warnings = [];
      for (const c of courses) {
        try {
          const gb = await getGradebookData(c);
          summaries.push({
            courseName: c.courseName,
            courseCode: c.courseCode,
            currentPercentage: gb.currentPercentage,
            letterGrade: gb.letterGrade,
            categories: gb.categories,
          });
        } catch (err) {
          if (err instanceof SessionExpiredError) throw err;
          warnings.push(`Could not load ${c.courseName}: ${err.message}`);
        }
      }
      if (warnings.length > 0) {
        summaries._warnings = warnings;
      }
      return summaries;
    }),

    getSchedule: wrapErrors(async () => {
      const cached = getCached("schedule");
      if (cached) return cached;

      const courses = await getCourses();
      const html = await http.get("student/top/schedule");
      const scheduleData = parseGlobalSchedule(html);

      // Match schedule data to course info
      const results = courses.map((c) => {
        const sched = scheduleData.find((s) => s.courseId === c.courseId);
        return {
          courseName: c.courseName,
          courseCode: c.courseCode,
          days: [], // LS doesn't store meeting days — comes from BYU registration
          startTime: sched ? sched.startTime : null,
          endTime: null, // sectionInfo only has start time
          building: sched ? sched.building : null,
          room: sched ? sched.room : null,
          instructor: null, // Not available from schedule data
        };
      });

      setCache("schedule", results);
      return results;
    }),

    getAnnouncements: wrapErrors(async ({ course, limit = 10 } = {}) => {
      const cacheKey = "announcements";
      let all = getCached(cacheKey);
      if (!all) {
        const html = await http.get("student/top/announcements");
        all = parseAllAnnouncements(html);
        setCache(cacheKey, all);
      }

      // Map course codes to course names using our course list
      const courses = await getCourses();
      const codeToName = new Map();
      for (const c of courses) {
        if (c.courseCode) codeToName.set(c.courseCode, c.courseName);
      }

      let filtered = all.map((a) => ({
        courseName: codeToName.get(a.courseCode) || a.courseCode || "Unknown",
        postedDate: a.postedDate,
        title: a.title,
        body:
          a.body && a.body.length > 500
            ? a.body.slice(0, 497) + "..."
            : a.body,
        author: a.author,
      }));

      if (course) {
        filtered = filtered.filter((a) => matchesCourse(a, course));
      }

      return filtered
        .sort((a, b) => new Date(b.postedDate || 0) - new Date(a.postedDate || 0))
        .slice(0, limit);
    }),

    getExams: wrapErrors(async ({ course } = {}) => {
      const now = new Date();
      const courses = await getCourses();
      const filtered = courses.filter((c) => matchesCourse(c, course));
      const results = [];
      const warnings = [];

      for (const c of filtered) {
        try {
          const cacheKey = `exams-${c.courseId}`;
          let exams = getCached(cacheKey);
          if (!exams) {
            const html = await http.get(`cid-${c.courseId}/student/exam`);
            exams = parseCourseExams(html);
            setCache(cacheKey, exams);
          }

          for (const e of exams) {
            const examDate = e.examDate ? new Date(e.examDate) : null;
            if (examDate && examDate < now) continue;

            results.push({
              courseName: c.courseName,
              title: e.title,
              examDate: e.examDate,
              startWindow: e.startWindow,
              endWindow: e.endWindow,
              location: null, // LS doesn't specify testing center vs in-class
              notes: e.status === "complete" ? "Completed" : null,
            });
          }
        } catch (err) {
          if (err instanceof SessionExpiredError) throw err;
          warnings.push(`Could not load ${c.courseName}: ${err.message}`);
        }
      }

      const sorted = results.sort(
        (a, b) => new Date(a.examDate || "9999") - new Date(b.examDate || "9999")
      );
      if (warnings.length > 0) {
        sorted._warnings = warnings;
      }
      return sorted;
    }),

    getContent: wrapErrors(async ({ course } = {}) => {
      const courses = await getCourses();
      const filtered = courses.filter((c) => matchesCourse(c, course));
      const results = [];
      const warnings = [];

      for (const c of filtered) {
        try {
          const cacheKey = `content-${c.courseId}`;
          let items = getCached(cacheKey);
          if (!items) {
            const html = await http.get(`cid-${c.courseId}/student/pages`);
            items = parseCourseContent(html);
            setCache(cacheKey, items);
          }

          for (const item of items) {
            results.push({
              courseName: c.courseName,
              ...item,
            });
          }
        } catch (err) {
          if (err instanceof SessionExpiredError) throw err;
          warnings.push(`Could not load ${c.courseName}: ${err.message}`);
        }
      }

      if (results.length === 0) {
        return [
          {
            courseName: "Note",
            section: "",
            title: "Content pages may require browser rendering. Data may be limited.",
            type: "note",
            url: null,
          },
        ];
      }

      if (warnings.length > 0) {
        results._warnings = warnings;
      }
      return results;
    }),

    getAssignmentDetails: wrapErrors(async ({ course, assignment } = {}) => {
      if (!course || !assignment) {
        return { error: "Both course and assignment parameters are required." };
      }

      const courses = await getCourses();
      const match = courses.find((c) => matchesCourse(c, course));
      if (!match) return { error: `No course found matching "${course}"` };

      const gb = await getGradebookData(match);
      const search = assignment.toLowerCase();

      // Find matching assignments (fuzzy match on name)
      const matches = gb.rawAssignments.filter((a) =>
        a.name.toLowerCase().includes(search)
      );

      if (matches.length === 0) {
        return { error: `No assignment found matching "${assignment}" in ${match.courseName}` };
      }

      return matches.map((a) => {
        // Strip HTML from description
        const rawDesc = a.description || "";
        const textDesc = rawDesc
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/p>/gi, "\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&mdash;/g, "—")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

        // Extract file download links
        const fileLinks = [...rawDesc.matchAll(
          /embededFile_Name">([^<]+)<\/span>.*?fileDownload\.php\?fileId=([^"'&]+)/gs
        )].map((m) => ({
          fileName: m[1].trim(),
          downloadUrl: `https://learningsuite.byu.edu/plugins/Upload/fileDownload.php?fileId=${m[2]}`,
        }));

        const hasScore = gb.rawScores.has(a.id);
        const score = gb.rawScores.get(a.id);

        // Find category name
        const catMap = new Map();
        for (const c of gb.categories) {
          catMap.set(c.name, c);
        }
        const catName = gb.assignmentScores.find(
          (as) => as.title === a.name
        )?.category;

        return {
          courseName: match.courseName,
          courseCode: match.courseCode,
          title: a.name,
          description: textDesc || "No description available.",
          dueDate: a.dueDate,
          dueDateFormatted: a.fullDueTime || null,
          pointsPossible: a.points,
          category: catName || null,
          status: hasScore ? "graded" : "not submitted",
          score: hasScore ? score : null,
          submissionType: a.onlineSubmission || "none",
          allowLateSubmission: a.allowLateSubmission || false,
          files: fileLinks,
        };
      });
    }),

    downloadFiles: wrapErrors(async ({ course, assignment } = {}) => {
      if (!course || !assignment) {
        return { error: "Both course and assignment parameters are required." };
      }

      const courses = await getCourses();
      const match = courses.find((c) => matchesCourse(c, course));
      if (!match) return { error: `No course found matching "${course}"` };

      const gb = await getGradebookData(match);
      const search = assignment.toLowerCase();

      // Find the best matching assignment
      const found = gb.rawAssignments.find((a) =>
        a.name.toLowerCase().includes(search)
      );
      if (!found) {
        return { error: `No assignment found matching "${assignment}" in ${match.courseName}` };
      }

      // Extract file links from description
      const rawDesc = found.description || "";
      const fileLinks = [
        ...rawDesc.matchAll(
          /embededFile_Name">([^<]+)<\/span>.*?fileDownload\.php\?fileId=([^"'&]+)/gs
        ),
      ].map((m) => ({
        fileName: m[1].trim(),
        fileId: m[2],
      }));

      if (fileLinks.length === 0) {
        return { error: `No downloadable files found for "${found.name}"` };
      }

      // Create download directory
      const sanitized = match.courseCode
        ? match.courseCode.replace(/\s+/g, "_")
        : "course";
      const downloadDir = join(homedir(), "Downloads", "BYU-LS", sanitized);
      mkdirSync(downloadDir, { recursive: true });

      const cookieHeader = authState.cookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");

      const downloaded = [];
      for (const file of fileLinks) {
        const url = `https://learningsuite.byu.edu/plugins/Upload/fileDownload.php?fileId=${file.fileId}`;
        const res = await fetch(url, {
          headers: { Cookie: cookieHeader },
          redirect: "follow",
        });

        if (!res.ok) {
          downloaded.push({
            fileName: file.fileName,
            status: "failed",
            error: `HTTP ${res.status}`,
          });
          continue;
        }

        const buffer = Buffer.from(await res.arrayBuffer());
        const filePath = join(downloadDir, file.fileName);
        writeFileSync(filePath, buffer);

        downloaded.push({
          fileName: file.fileName,
          filePath,
          size: `${(buffer.length / 1024).toFixed(1)} KB`,
          status: "downloaded",
        });
      }

      return {
        assignment: found.name,
        course: `${match.courseCode} — ${match.courseName}`,
        downloadDirectory: downloadDir,
        files: downloaded,
      };
    }),

    whatIfGrade: wrapErrors(async ({ course, targetGrade, assignment, hypotheticalScore } = {}) => {
      if (!course) return { error: "Course is required." };

      const courses = await getCourses();
      const match = courses.find((c) => matchesCourse(c, course));
      if (!match) return { error: `No course found matching "${course}"` };

      const gb = await getGradebookData(match);

      // If hypothetical score on a specific assignment
      if (assignment && hypotheticalScore !== undefined) {
        const search = assignment.toLowerCase();
        const found = gb.rawAssignments.find((a) => a.name.toLowerCase().includes(search));
        if (!found) return { error: `No assignment matching "${assignment}"` };

        // Clone scores and add the hypothetical
        const modifiedScores = new Map(gb.rawScores);
        modifiedScores.set(found.id, hypotheticalScore);

        // Recalculate using the modified scores
        const newPct = recalculateGrade(gb.rawAssignments, gb.categories, modifiedScores);

        return {
          courseName: match.courseName,
          currentGrade: `${gb.currentPercentage}% (${gb.letterGrade})`,
          scenario: `If you score ${hypotheticalScore}/${found.points} on "${found.name}"`,
          projectedPercentage: newPct.percentage,
          projectedGrade: lookupLetterGrade(newPct.percentage, gb),
          change: newPct.percentage !== null && gb.currentPercentage !== null
            ? `${(newPct.percentage - gb.currentPercentage).toFixed(2)}%`
            : null,
        };
      }

      // "What do I need to get an X?"
      if (targetGrade) {
        const gradeScale = gb._gradeScale;
        if (!gradeScale || !gradeScale.items) {
          return { error: "Grade scale not available for this course." };
        }
        const threshold = gradeScale.items[targetGrade];
        if (threshold === undefined) {
          return { error: `"${targetGrade}" not found. Available: ${Object.keys(gradeScale.items).join(", ")}` };
        }

        // Find ungraded assignments
        const ungraded = gb.rawAssignments.filter(
          (a) => a.graded && !gb.rawScores.has(a.id)
        );

        return {
          courseName: match.courseName,
          currentGrade: `${gb.currentPercentage}% (${gb.letterGrade})`,
          targetGrade,
          targetThreshold: `${threshold}%`,
          currentPercentage: gb.currentPercentage,
          gap: gb.currentPercentage !== null ? `${(threshold - gb.currentPercentage).toFixed(2)}%` : null,
          ungradedAssignments: ungraded.map((a) => ({
            name: a.name,
            points: a.points,
            dueDate: a.dueDate,
            category: gb.assignmentScores.find((as) => as.title === a.name)?.category,
          })),
          advice: gb.currentPercentage >= threshold
            ? `You're already above the ${targetGrade} threshold (${threshold}%). Keep it up!`
            : `You need to average ${threshold}%+ on remaining work to reach a ${targetGrade}.`,
        };
      }

      // Default: show current grade and all category breakdowns
      return {
        courseName: match.courseName,
        currentGrade: `${gb.currentPercentage}% (${gb.letterGrade})`,
        categories: gb.categories,
        gradeScale: gb._gradeScale ? gb._gradeScale.items : null,
      };
    }),

    getDeadlines: wrapErrors(async ({ daysAhead = 30, course } = {}) => {
      const now = new Date();
      const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
      const courses = await getCourses();
      const filtered = courses.filter((c) => matchesCourse(c, course));
      const deadlines = [];
      const warnings = [];

      for (const c of filtered) {
        try {
          const gb = await getGradebookData(c);

          for (const a of gb.rawAssignments) {
            if (!a.dueDate || gb.rawScores.has(a.id)) continue;
            const due = new Date(a.dueDate.replace(" ", "T") + "-07:00");
            if (due < now || due > cutoff) continue;

            const daysUntil = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
            const catWeight = gb.categories.find(
              (cat) => cat.name === (gb.assignmentScores.find((as) => as.title === a.name) || {}).category
            )?.weight || 0;

            // Priority: higher points × category weight, adjusted by urgency
            const urgencyMultiplier = daysUntil <= 2 ? 3 : daysUntil <= 7 ? 2 : 1;
            const priority = a.points * (catWeight / 100) * urgencyMultiplier;

            deadlines.push({
              courseName: c.courseName,
              courseCode: c.courseCode,
              title: a.name,
              dueDate: due.toISOString(),
              dueDateFormatted: a.fullDueTime || null,
              daysUntil,
              pointsPossible: a.points,
              categoryWeight: `${catWeight}%`,
              priority: Math.round(priority * 100) / 100,
              type: inferAssignmentCategory(a, { name: gb.assignmentScores.find((as) => as.title === a.name)?.category || "" }),
            });
          }

          // Also include exams
          const cacheKey = `exams-${c.courseId}`;
          let exams = getCached(cacheKey);
          if (!exams) {
            try {
              const html = await http.get(`cid-${c.courseId}/student/exam`);
              const { parseCourseExams } = await import("../scraper/parsers.js");
              exams = parseCourseExams(html);
              setCache(cacheKey, exams);
            } catch { exams = []; }
          }
          for (const e of exams) {
            if (!e.startWindow || e.status === "complete") continue;
            const examDate = new Date(e.startWindow.replace(" ", "T") + "-07:00");
            if (examDate < now || examDate > cutoff) continue;
            const daysUntil = Math.ceil((examDate - now) / (1000 * 60 * 60 * 24));

            deadlines.push({
              courseName: c.courseName,
              courseCode: c.courseCode,
              title: e.title,
              dueDate: examDate.toISOString(),
              daysUntil,
              pointsPossible: null,
              categoryWeight: null,
              priority: daysUntil <= 2 ? 999 : 500,
              type: "exam",
            });
          }
        } catch (err) {
          if (err instanceof SessionExpiredError) throw err;
          warnings.push(`Could not load ${c.courseName}: ${err.message}`);
        }
      }

      const sorted = deadlines.sort((a, b) => b.priority - a.priority);
      if (warnings.length > 0) {
        sorted._warnings = warnings;
      }
      return sorted;
    }),

    getUniversityCalendar: wrapErrors(async () => {
      const cached = getCached("univCalendar");
      if (cached) return cached;

      const html = await http.get("student/top/schedule");
      const dates = parseUniversityCalendar(html);
      setCache("univCalendar", dates);
      return dates;
    }),

    getSyllabus: wrapErrors(async ({ course } = {}) => {
      const courses = await getCourses();
      const match = courses.find((c) => matchesCourse(c, course));
      if (!match) return { error: `No course found matching "${course}"` };

      const html = await http.get(`cid-${match.courseId}/student/syllabus`);
      const fileId = parseSyllabusLink(html);
      if (!fileId) return { error: `No syllabus file found for ${match.courseName}` };

      const cookieHeader = authState.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const url = `https://learningsuite.byu.edu/plugins/Upload/fileDownload.php?fileId=${fileId}`;
      const res = await fetch(url, { headers: { Cookie: cookieHeader }, redirect: "follow" });
      if (!res.ok) return { error: `Failed to download syllabus: HTTP ${res.status}` };

      const disposition = res.headers.get("content-disposition") || "";
      const nameMatch = disposition.match(/filename="?([^"]+)"?/);
      const fileName = nameMatch ? nameMatch[1] : `${match.courseCode}_Syllabus.pdf`;

      const sanitized = match.courseCode ? match.courseCode.replace(/\s+/g, "_") : "course";
      const downloadDir = join(homedir(), "Downloads", "BYU-LS", sanitized);
      mkdirSync(downloadDir, { recursive: true });

      const buffer = Buffer.from(await res.arrayBuffer());
      const filePath = join(downloadDir, fileName);
      writeFileSync(filePath, buffer);

      return {
        courseName: match.courseName,
        courseCode: match.courseCode,
        fileName,
        filePath,
        size: `${(buffer.length / 1024).toFixed(1)} KB`,
      };
    }),

    getGroupMembers: wrapErrors(async ({ course } = {}) => {
      const courses = await getCourses();
      const match = courses.find((c) => matchesCourse(c, course));
      if (!match) return { error: `No course found matching "${course}"` };

      const html = await http.get(`cid-${match.courseId}/student/home/groups`);
      // Extract student ID from auth state
      const studentId = authState.cookies.find((c) => c.name === "studentId")?.value
        || html.match(/"studentID":\s*"(\d+)"/)?.[1]
        || null;

      const groups = parseGroupMembers(html, studentId);
      return {
        courseName: match.courseName,
        courseCode: match.courseCode,
        yourGroups: groups,
      };
    }),

    searchAssignments: wrapErrors(async ({ query, course } = {}) => {
      if (!query) return { error: "Search query is required." };
      const search = query.toLowerCase();
      const courses = await getCourses();
      const filtered = courses.filter((c) => matchesCourse(c, course));
      const results = [];
      const warnings = [];

      for (const c of filtered) {
        try {
          const gb = await getGradebookData(c);
          for (const a of gb.rawAssignments) {
            const nameMatch = a.name.toLowerCase().includes(search);
            const descMatch = (a.description || "").toLowerCase().includes(search);
            if (!nameMatch && !descMatch) continue;

            const hasScore = gb.rawScores.has(a.id);
            results.push({
              courseName: c.courseName,
              courseCode: c.courseCode,
              title: a.name,
              dueDate: a.dueDate,
              pointsPossible: a.points,
              status: hasScore ? "graded" : "not submitted",
              score: hasScore ? gb.rawScores.get(a.id) : null,
              hasFiles: (a.description || "").includes("fileDownload"),
              matchedIn: nameMatch ? "title" : "description",
            });
          }
        } catch (err) {
          if (err instanceof SessionExpiredError) throw err;
          warnings.push(`Could not load ${c.courseName}: ${err.message}`);
        }
      }

      if (warnings.length > 0) {
        results._warnings = warnings;
      }
      return results;
    }),

    submitAssignment: wrapErrors(async ({ course, assignment, filePath } = {}) => {
      // Verify file exists
      if (!filePath || !existsSync(filePath)) {
        return { error: `File not found: ${filePath}` };
      }

      const courses = await getCourses();
      const match = courses.find((c) => matchesCourse(c, course));
      if (!match) return { error: `No course found matching "${course}"` };

      const gb = await getGradebookData(match);
      const search = assignment.toLowerCase();
      const found = gb.rawAssignments.find((a) => a.name.toLowerCase().includes(search));
      if (!found) return { error: `No assignment matching "${assignment}"` };

      if (found.onlineSubmission === "none") {
        return { error: `"${found.name}" does not accept online submissions.` };
      }

      // Read the file
      const fileBuffer = readFileSync(filePath);
      const fileName = filePath.split("/").pop();
      const cookieHeader = authState.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

      // Build multipart form data
      const formData = new FormData();
      formData.append("subsessionID", authState.sessionCode);
      formData.append("courseID", match.courseId);
      formData.append("assignmentID", found.id);
      formData.append("file", new Blob([fileBuffer]), fileName);

      // Try the upload endpoint
      const url = `https://learningsuite.byu.edu/plugins/Upload/fileUpload.php`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { Cookie: cookieHeader },
          body: formData,
        });
        const body = await res.text();

        if (res.ok) {
          return {
            status: "submitted",
            assignment: found.name,
            course: `${match.courseCode} — ${match.courseName}`,
            fileName,
            message: "File uploaded successfully. Verify on Learning Suite that the submission appears.",
          };
        }
        return { error: `Upload failed (HTTP ${res.status}). The upload endpoint may need adjustment. Check Learning Suite directly.` };
      } catch (err) {
        return { error: `Upload failed: ${err.message}. The upload endpoint may need reverse-engineering. Submit via Learning Suite for now.` };
      }
    }),
  };
}

export function recalculateGrade(assignments, categories, scoreMap) {
  // Build category lookup from the categories array
  const catTotals = new Map();
  for (const cat of categories) {
    catTotals.set(cat.name, { weight: cat.weight, earned: 0, possible: 0, count: 0, equalWeight: false });
  }

  // Build assignment-to-category mapping from assignmentScores
  // We need the raw category info — use the categories parameter which has name/weight/currentScore
  // For recalculation, we accumulate earned/possible per category from the scoreMap

  // Group assignments by categoryID and match to category names
  const catIdToName = new Map();
  // categories here are the categoryScores array (with name, weight, currentScore)
  // We need to match assignments to their category by using the assignmentScores mapping
  // Since we don't have that mapping here, use a simpler approach:
  // Sum all scored assignments' points and compute overall percentage

  let totalEarned = 0;
  let totalPossible = 0;

  for (const a of assignments) {
    if (!a.graded) continue;
    const score = scoreMap.get(a.id);
    if (score === undefined || score === null) continue;
    totalEarned += score;
    totalPossible += a.points;
  }

  const percentage = totalPossible > 0
    ? Math.round((totalEarned / totalPossible) * 10000) / 100
    : null;

  return { percentage };
}

export function lookupLetterGrade(percentage, gb) {
  if (!gb._gradeScale || !gb._gradeScale.items || percentage === null) return null;
  const sorted = Object.entries(gb._gradeScale.items).sort((a, b) => b[1] - a[1]);
  for (const [letter, threshold] of sorted) {
    if (percentage >= threshold) return letter;
  }
  return "E";
}

function inferAssignmentCategory(assignment, categoryInfo) {
  const name = (assignment.name || "").toLowerCase();
  const catName = (categoryInfo && categoryInfo.name || "").toLowerCase();

  if (
    name.includes("exam") || name.includes("midterm") || name.includes("final") ||
    catName.includes("exam") || catName.includes("midterm") || catName.includes("final")
  ) return "exam";

  if (name.includes("project") || name.includes("presentation")) return "project";
  if (name.includes("participation") || name.includes("attendance") || catName.includes("participation")) return "participation";
  return "homework";
}
