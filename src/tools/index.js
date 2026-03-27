import { z } from "zod";

function formatResult(results) {
  if (results && results.error) {
    return {
      isError: true,
      content: [{ type: "text", text: results.error }],
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
  };
}

/**
 * Registers all Learning Suite tools on the given MCP server,
 * using the provided data adapter for all queries.
 */
export function registerTools(server, data) {
  server.tool(
    "get_assignments",
    "Returns upcoming assignments across all enrolled courses. Supports optional course filter and days_ahead window.",
    {
      course: z
        .string()
        .optional()
        .describe("Filter by course name or code (e.g. 'FIN 401' or 'Corporate Finance')"),
      days_ahead: z
        .number()
        .int()
        .positive()
        .optional()
        .default(14)
        .describe("Number of days ahead to look (default 14)"),
    },
    async ({ course, days_ahead }) => {
      const results = await data.getAssignments({ course, daysAhead: days_ahead });
      return formatResult(results);
    }
  );

  server.tool(
    "get_grades",
    "Returns current grade summary by course. Pass a course name/code to get individual assignment scores for that class.",
    {
      course: z
        .string()
        .optional()
        .describe("Drill into a specific course for assignment-level scores"),
    },
    async ({ course }) => {
      const results = await data.getGrades({ course });
      return formatResult(results);
    }
  );

  server.tool(
    "get_schedule",
    "Returns the weekly class schedule with times, locations, and instructors.",
    {},
    async () => {
      const results = await data.getSchedule();
      return formatResult(results);
    }
  );

  server.tool(
    "get_announcements",
    "Returns recent course announcements. Supports optional course filter and result limit.",
    {
      course: z
        .string()
        .optional()
        .describe("Filter by course name or code"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(10)
        .describe("Maximum number of announcements to return (default 10)"),
    },
    async ({ course, limit }) => {
      const results = await data.getAnnouncements({ course, limit });
      return formatResult(results);
    }
  );

  server.tool(
    "get_exams",
    "Returns upcoming exams and testing center windows.",
    {
      course: z
        .string()
        .optional()
        .describe("Filter by course name or code"),
    },
    async ({ course }) => {
      const results = await data.getExams({ course });
      return formatResult(results);
    }
  );

  server.tool(
    "get_assignment_details",
    "Returns full details for a specific assignment including description, instructions, rubric, file download links, and submission info. Use this when someone asks about a specific assignment's requirements or attached files.",
    {
      course: z
        .string()
        .describe("Course name or code (e.g. 'HRM 391' or 'Organizational Effectiveness')"),
      assignment: z
        .string()
        .describe("Assignment name or partial name to search for (e.g. 'Leadership' or 'Midterm')"),
    },
    async ({ course, assignment }) => {
      const results = await data.getAssignmentDetails({ course, assignment });
      return formatResult(results);
    }
  );

  server.tool(
    "download_files",
    "Downloads attachment files (docx, xlsx, pdf, etc.) from a specific assignment in BYU Learning Suite to the local Downloads folder. Returns local file paths. Use this when someone wants to access or view assignment files.",
    {
      course: z
        .string()
        .describe("Course name or code (e.g. 'FIN 401')"),
      assignment: z
        .string()
        .describe("Assignment name or partial name (e.g. 'Problem Set 1')"),
    },
    async ({ course, assignment }) => {
      const results = await data.downloadFiles({ course, assignment });
      return formatResult(results);
    }
  );

  server.tool(
    "get_content",
    "Returns course content and resources (slides, readings, videos, links).",
    {
      course: z
        .string()
        .optional()
        .describe("Filter by course name or code"),
    },
    async ({ course }) => {
      const results = await data.getContent({ course });
      return formatResult(results);
    }
  );

  server.tool(
    "what_if_grade",
    "Grade calculator — answers 'What do I need on X to get a Y?' Shows what scores are needed on remaining assignments/exams to reach a target letter grade, or calculates the impact of a hypothetical score.",
    {
      course: z.string().describe("Course name or code"),
      target_grade: z
        .string()
        .optional()
        .describe("Target letter grade (e.g. 'A', 'B+')"),
      assignment: z
        .string()
        .optional()
        .describe("Specific assignment name to simulate a score on"),
      hypothetical_score: z
        .number()
        .optional()
        .describe("Hypothetical score for the specified assignment"),
    },
    async ({ course, target_grade, assignment, hypothetical_score }) => {
      const results = await data.whatIfGrade({
        course,
        targetGrade: target_grade,
        assignment,
        hypotheticalScore: hypothetical_score,
      });
      return formatResult(results);
    }
  );

  server.tool(
    "get_deadlines",
    "Returns a priority-ranked list of everything due soon — assignments and exams combined, ordered by urgency and importance (points × weight). Use this for a 'what should I focus on?' overview.",
    {
      days_ahead: z
        .number()
        .int()
        .positive()
        .optional()
        .default(30)
        .describe("How many days ahead to look (default 30)"),
      course: z.string().optional().describe("Filter by course"),
    },
    async ({ days_ahead, course }) => {
      const results = await data.getDeadlines({ daysAhead: days_ahead, course });
      return formatResult(results);
    }
  );

  server.tool(
    "get_university_calendar",
    "Returns BYU university calendar dates — holidays, last day of class, exam periods, etc.",
    {},
    async () => {
      const results = await data.getUniversityCalendar();
      return formatResult(results);
    }
  );

  server.tool(
    "get_syllabus",
    "Downloads the syllabus file for a course to the local Downloads folder and returns the file path.",
    {
      course: z.string().describe("Course name or code"),
    },
    async ({ course }) => {
      const results = await data.getSyllabus({ course });
      return formatResult(results);
    }
  );

  server.tool(
    "get_group_members",
    "Returns group/team membership for a course — who is in your group for team projects.",
    {
      course: z.string().describe("Course name or code"),
    },
    async ({ course }) => {
      const results = await data.getGroupMembers({ course });
      return formatResult(results);
    }
  );

  server.tool(
    "search_assignments",
    "Search across all courses for assignments matching a keyword. Useful for finding past assignments, specific topics, or files.",
    {
      query: z.string().describe("Search term (e.g. 'midterm', 'excel', 'case')"),
      course: z.string().optional().describe("Limit search to a specific course"),
    },
    async ({ query, course }) => {
      const results = await data.searchAssignments({ query, course });
      return formatResult(results);
    }
  );

  server.tool(
    "submit_assignment",
    "Submits a file to BYU Learning Suite for a specific assignment. Requires the local file path. EXPERIMENTAL — use with caution.",
    {
      course: z.string().describe("Course name or code"),
      assignment: z.string().describe("Assignment name"),
      file_path: z.string().describe("Absolute path to the file to submit"),
    },
    async ({ course, assignment, file_path }) => {
      const results = await data.submitAssignment({ course, assignment, filePath: file_path });
      return formatResult(results);
    }
  );
}
