import {
  courses,
  assignments,
  grades,
  announcements,
  exams,
  content,
} from "./mockData.js";

function matchesCourse(item, courseFilter) {
  if (!courseFilter) return true;
  const filter = courseFilter.toLowerCase();
  return (
    item.courseName.toLowerCase().includes(filter) ||
    (item.courseCode && item.courseCode.toLowerCase().includes(filter))
  );
}

export const mockDataSource = {
  async getAssignments({ course, daysAhead = 14 } = {}) {
    const now = new Date();
    const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    return assignments
      .filter((a) => {
        const due = new Date(a.dueDate);
        return due >= now && due <= cutoff && matchesCourse(a, course);
      })
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
      .map(({ courseCode, ...rest }) => rest);
  },

  async getGrades({ course } = {}) {
    if (course) {
      const match = grades.find((g) => matchesCourse(g, course));
      if (!match) return { error: `No course found matching "${course}"` };
      return match;
    }
    return grades.map(({ assignmentScores, ...summary }) => summary);
  },

  async getSchedule() {
    return courses.map((c) => ({
      courseName: c.name,
      courseCode: c.code,
      days: c.days,
      startTime: c.startTime,
      endTime: c.endTime,
      building: c.building,
      room: c.room,
      instructor: c.instructor,
    }));
  },

  async getAnnouncements({ course, limit = 10 } = {}) {
    return announcements
      .filter((a) => matchesCourse(a, course))
      .sort((a, b) => new Date(b.postedDate) - new Date(a.postedDate))
      .slice(0, limit)
      .map((a) => ({
        ...a,
        body: a.body.length > 500 ? a.body.slice(0, 497) + "..." : a.body,
        courseCode: undefined,
      }))
      .map(({ courseCode, ...rest }) => rest);
  },

  async getExams({ course } = {}) {
    const now = new Date();
    return exams
      .filter((e) => new Date(e.examDate) >= now && matchesCourse(e, course))
      .sort((a, b) => new Date(a.examDate) - new Date(b.examDate))
      .map(({ courseCode, ...rest }) => rest);
  },

  async getContent({ course } = {}) {
    return content
      .filter((c) => matchesCourse(c, course))
      .map(({ courseCode, ...rest }) => rest);
  },

  async downloadFiles({ course, assignment } = {}) {
    return { error: "File downloads are only available with a real Learning Suite connection. Run 'npm run auth' to connect." };
  },

  async getAssignmentDetails({ course, assignment } = {}) {
    if (!course || !assignment) {
      return { error: "Both course and assignment parameters are required." };
    }
    const search = assignment.toLowerCase();
    const match = assignments.find(
      (a) => matchesCourse(a, course) && a.title.toLowerCase().includes(search)
    );
    if (!match) return { error: `No assignment found matching "${assignment}"` };
    return [{
      courseName: match.courseName,
      title: match.title,
      description: "Mock data — no description available. Connect to real Learning Suite for full details.",
      dueDate: match.dueDate,
      pointsPossible: match.pointsPossible,
      category: match.category,
      status: match.status,
      files: [],
    }];
  },

  async whatIfGrade() { return { error: "Grade calculator requires real LS connection." }; },
  async getDeadlines() { return { error: "Deadlines require real LS connection." }; },
  async getUniversityCalendar() { return { error: "Calendar requires real LS connection." }; },
  async getSyllabus() { return { error: "Syllabus download requires real LS connection." }; },
  async getGroupMembers() { return { error: "Groups require real LS connection." }; },
  async searchAssignments() { return { error: "Search requires real LS connection." }; },
  async submitAssignment() { return { error: "Submission requires real LS connection." }; },
};
