/**
 * Parsers for BYU Learning Suite pages.
 *
 * All LS data is embedded as JavaScript objects in the HTML
 * (Vue component initialization). We extract JSON via bracket-matched
 * regex, not DOM parsing.
 */

import { ParseError } from "./errors.js";

// --- JSON extraction helpers ---

/**
 * Extracts a JSON array or object that follows `prefix` in the HTML.
 * Handles nested brackets and string escapes correctly.
 */
function extractJSONAfter(html, prefix) {
  const idx = html.indexOf(prefix);
  if (idx === -1) return null;

  const start = idx + prefix.length;
  const opener = html[start];
  if (opener !== "[" && opener !== "{") return null;
  const closer = opener === "[" ? "]" : "}";

  let depth = 1;
  let i = start + 1;
  let inString = false;
  let escape = false;

  while (i < html.length && depth > 0) {
    const ch = html[i];
    if (escape) {
      escape = false;
      i++;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      i++;
      continue;
    }
    if (!inString) {
      if (ch === opener) depth++;
      else if (ch === closer) depth--;
    }
    i++;
  }

  if (depth !== 0) return null;
  return JSON.parse(html.slice(start, i));
}

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- Parsers ---

/**
 * Parse course list from the student dashboard.
 * Source: instance.initialCourseGroups = {...}
 */
export function parseCourseList(html) {
  const data = extractJSONAfter(html, "initialCourseGroups = ");
  if (!data || !data.data) {
    throw new ParseError("dashboard", "Could not find initialCourseGroups data.");
  }

  const courses = [];
  for (const group of data.data.courseGroups) {
    for (const c of group.courseList) {
      // courseTitle format: "FIN 401 (003)  - Adv Financial Management"
      const titleMatch = c.courseTitle.match(
        /^([A-Z]{2,5}\s*\d{3}[A-Z]?)\s*(?:\(\d+\))?\s*[-–]\s*(.+)/
      );
      // href format: ".Ydj6/cid-3w_iiyj5-k6S/student/home"
      const cidMatch = (c.href || "").match(/cid-([A-Za-z0-9_-]+)/);

      courses.push({
        courseId: cidMatch ? cidMatch[1] : null,
        courseCode: titleMatch ? titleMatch[1].trim() : null,
        courseName: titleMatch ? titleMatch[2].trim() : c.courseTitle,
        fullTitle: c.courseTitle,
      });
    }
  }

  if (courses.length === 0) {
    throw new ParseError("dashboard", "No courses found in initialCourseGroups.");
  }
  return courses;
}

/**
 * Parse gradebook data for one course.
 * Source: datastore.categories.reset([...]), datastore.assignments.reset([...]),
 *         datastore.scores.reset([...]), datastore.gradeScale.set({...})
 */
export function parseGradebook(html) {
  const categories = extractJSONAfter(html, "datastore.categories.reset(") || [];
  const assignments = extractJSONAfter(html, "datastore.assignments.reset(") || [];
  const scores = extractJSONAfter(html, "datastore.scores.reset(") || [];
  const gradeScale = extractJSONAfter(html, "datastore.gradeScale.set(");

  // Build score lookup: gbAssignmentID -> score
  // Scores reference assignments via assignment.gbAssignmentID, NOT assignment.id
  const scoreMap = new Map();
  for (const s of scores) {
    scoreMap.set(s.assignmentID, s.score);
  }

  // Build gbAssignmentID -> assignment.id mapping
  const gbIdToAssignId = new Map();
  for (const a of assignments) {
    if (a.gbAssignmentID) {
      gbIdToAssignId.set(a.gbAssignmentID, a.id);
    }
  }

  // Build category lookup: id -> category info
  const categoryMap = new Map();
  for (const cat of categories) {
    categoryMap.set(cat.id, {
      id: cat.id,
      title: cat.title,
      weight: cat.weight,
      equalAssignWeight: cat.equalAssignWeight,
      lowScoresToDrop: cat.lowScoresToDrop || 0,
      extraCredit: cat.extraCredit || false,
    });
  }

  // Calculate category scores
  const categoryScores = [];
  for (const cat of categories) {
    const catAssignments = assignments.filter(
      (a) => a.categoryID === cat.id && a.graded
    );

    let totalEarned = 0;
    let totalPossible = 0;
    let scoredAssignments = [];

    for (const a of catAssignments) {
      const score = scoreMap.get(a.gbAssignmentID);
      if (score !== undefined && score !== null) {
        scoredAssignments.push({ earned: score, possible: a.points });
      }
    }

    // Handle low score drops
    if (cat.lowScoresToDrop > 0 && scoredAssignments.length > cat.lowScoresToDrop) {
      scoredAssignments.sort(
        (a, b) => a.earned / a.possible - b.earned / b.possible
      );
      scoredAssignments = scoredAssignments.slice(cat.lowScoresToDrop);
    }

    if (cat.equalAssignWeight) {
      // Each assignment has equal weight in the category
      let percentSum = 0;
      for (const sa of scoredAssignments) {
        percentSum += sa.possible > 0 ? (sa.earned / sa.possible) * 100 : 0;
      }
      const catScore =
        scoredAssignments.length > 0
          ? percentSum / scoredAssignments.length
          : null;
      categoryScores.push({ name: cat.title, weight: cat.weight, currentScore: catScore });
    } else {
      // Points-based
      for (const sa of scoredAssignments) {
        totalEarned += sa.earned;
        totalPossible += sa.possible;
      }
      const catScore =
        totalPossible > 0 ? (totalEarned / totalPossible) * 100 : null;
      categoryScores.push({ name: cat.title, weight: cat.weight, currentScore: catScore });
    }
  }

  // Calculate overall weighted percentage
  let weightedSum = 0;
  let weightSum = 0;
  for (const cs of categoryScores) {
    if (cs.currentScore !== null) {
      weightedSum += cs.currentScore * cs.weight;
      weightSum += cs.weight;
    }
  }
  const currentPercentage = weightSum > 0 ? weightedSum / weightSum : null;

  // Determine letter grade from grade scale
  let letterGrade = null;
  if (gradeScale && gradeScale.items && currentPercentage !== null) {
    const sorted = Object.entries(gradeScale.items).sort((a, b) => b[1] - a[1]);
    for (const [letter, threshold] of sorted) {
      if (currentPercentage >= threshold) {
        letterGrade = letter;
        break;
      }
    }
  }

  // Build assignment scores list
  const assignmentScores = assignments
    .filter((a) => a.graded)
    .map((a) => ({
      title: a.name,
      pointsEarned: scoreMap.has(a.gbAssignmentID) ? scoreMap.get(a.gbAssignmentID) : null,
      pointsPossible: a.points,
      category: categoryMap.has(a.categoryID)
        ? categoryMap.get(a.categoryID).title
        : null,
    }));

  // Build score lookup by gbAssignmentID for the adapter
  const gbScoreMap = new Map();
  for (const a of assignments) {
    if (a.gbAssignmentID && scoreMap.has(a.gbAssignmentID)) {
      gbScoreMap.set(a.id, scoreMap.get(a.gbAssignmentID));
    }
  }

  return {
    currentPercentage: currentPercentage !== null ? Math.round(currentPercentage * 100) / 100 : null,
    letterGrade,
    categories: categoryScores.map((cs) => ({
      ...cs,
      currentScore: cs.currentScore !== null ? Math.round(cs.currentScore * 100) / 100 : null,
    })),
    assignmentScores,
    // Raw data for assignments tool
    rawAssignments: assignments,
    rawScores: gbScoreMap,
    _gradeScale: gradeScale,
  };
}

/**
 * Parse grade summary from the global summary page.
 * Source: CourseGradeSummaryDriver.init({ courseData: [...] })
 */
export function parseGradeSummary(html) {
  const courseData = extractJSONAfter(html, "courseData: ");
  if (!courseData) {
    throw new ParseError("grade-summary", "Could not find courseData.");
  }
  return courseData;
}

/**
 * Parse all announcements from the global announcements page.
 * Source: allAnnouncements: [...]
 */
export function parseAllAnnouncements(html) {
  const announcements = extractJSONAfter(html, "allAnnouncements: ");
  if (!announcements) {
    throw new ParseError("announcements", "Could not find allAnnouncements data.");
  }

  return announcements.map((item) => {
    const a = item.announcement;
    const courseMap = item.coursesToDisplay || {};
    const courseCode = Object.values(courseMap)[0] || null;

    return {
      courseCode,
      postedDate: a.date
        ? new Date(a.date * 1000).toISOString()
        : null,
      title: a.title,
      body: stripHtml(a.text || ""),
      author: a.creatorName || null,
    };
  });
}

/**
 * Parse schedule from the global schedule page.
 * Source: var courseInformation = [...]
 * sectionInfo format: "2:00 TNRB 184"
 */
export function parseGlobalSchedule(html) {
  const courses = extractJSONAfter(html, "var courseInformation = ");
  if (!courses) {
    throw new ParseError("schedule", "Could not find courseInformation data.");
  }

  return courses.map((c) => {
    const info = c.sectionInfo || "";
    // Parse "2:00 TNRB 184" or "12:30 TNRB 251"
    const match = info.match(
      /^(\d{1,2}:\d{2})\s+(\S+)\s+(\S+)$/
    );

    return {
      courseCode: c.title,
      courseId: c.id,
      startTime: match ? match[1] : null,
      building: match ? match[2] : null,
      room: match ? match[3] : null,
    };
  });
}

/**
 * Parse exams from a per-course exam page.
 * Source: instance.exams = [...], instance.gradebookScores = {...}
 */
export function parseCourseExams(html) {
  const exams = extractJSONAfter(html, "instance.exams = ");
  if (!exams) return [];

  return exams.map((e) => ({
    title: e.title,
    startWindow: e.beginDate || null,
    endWindow: e.endDate || null,
    examDate: e.beginDate ? e.beginDate.split(" ")[0] : null,
    status: e.status || null,
    timesTaken: e.timesTaken || 0,
  }));
}

/**
 * Parse content/pages from a per-course content page.
 * NOTE: LS content pages may be SPA-rendered. This parser handles
 * whatever data is embedded in the initial HTML. May return empty.
 */
export function parseCourseContent(html) {
  // Try to find any content data embedded in the page
  const pages = extractJSONAfter(html, "instance.pages = ");
  if (pages) {
    return pages.map((p) => ({
      section: p.sectionTitle || p.parentTitle || "General",
      title: p.title || p.name || "Untitled",
      type: inferContentType(p.url || p.fileName || "", p.title || ""),
      url: p.url || p.fileName || null,
    }));
  }

  // Fallback: try to find links in any embedded data
  const items = extractJSONAfter(html, "instance.items = ");
  if (items) {
    return items.map((item) => ({
      section: "General",
      title: item.title || item.name || "Untitled",
      type: inferContentType(item.url || "", item.title || ""),
      url: item.url || null,
    }));
  }

  return [];
}

/**
 * Parse university calendar dates from the global schedule page.
 * Source: AggregateCalendar.datastore.universityDates = {...}
 */
export function parseUniversityCalendar(html) {
  const dates = extractJSONAfter(html, "AggregateCalendar.datastore.universityDates = ");
  if (!dates) return [];

  const results = [];
  for (const [dateKey, events] of Object.entries(dates)) {
    for (const event of events) {
      results.push({
        date: dateKey,
        title: event.title,
      });
    }
  }
  return results.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Parse group members from a course groups page.
 * Source: var groupsMap = [...], var students = [...]
 */
export function parseGroupMembers(html, studentId) {
  const groups = extractJSONAfter(html, "var groupsMap = ");
  const students = extractJSONAfter(html, "var students = ");

  if (!groups || !students) return [];

  // Build student lookup
  const studentMap = new Map();
  for (const s of students) {
    studentMap.set(s.id, s.fullPreferredName || s.preferredName || s.sortName);
  }

  // Find groups the student belongs to
  return groups
    .filter((g) => !studentId || g.members.includes(studentId))
    .map((g) => ({
      groupName: g.title,
      members: g.members.map((id) => studentMap.get(id) || id),
    }));
}

/**
 * Parse syllabus download link from a course syllabus page.
 * Source: fileDownload.php?fileId=...
 */
export function parseSyllabusLink(html) {
  const match = html.match(/fileDownload\.php\?fileId=([^&"']+)/);
  if (!match) return null;
  return match[1];
}

function inferContentType(url, title) {
  const lower = (url + " " + title).toLowerCase();
  if (lower.match(/\.(ppt|pptx)/)) return "slides";
  if (lower.match(/\.(pdf|doc|docx|txt)/) || lower.includes("reading") || lower.includes("chapter")) return "reading";
  if (lower.includes("video") || lower.includes("youtube") || lower.includes(".mp4")) return "video";
  if (lower.startsWith("http")) return "link";
  return "reading";
}
