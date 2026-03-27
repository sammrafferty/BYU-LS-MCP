/**
 * Data adapter interface for BYU Learning Suite.
 *
 * To swap in a real backend, create a new module that exports the same
 * functions and pass it to createAdapter() — or replace mockAdapter.js
 * with your scraper implementation that satisfies this interface.
 */

/**
 * @typedef {Object} DataSource
 * @property {function(Object): Promise<Array>} getAssignments
 * @property {function(Object): Promise<Array>} getGrades
 * @property {function(Object): Promise<Array>} getSchedule
 * @property {function(Object): Promise<Array>} getAnnouncements
 * @property {function(Object): Promise<Array>} getExams
 * @property {function(Object): Promise<Array>} getContent
 */

/**
 * Creates a data adapter wrapping the given data source.
 * This is the single injection point — swap the source module
 * to move from mock data to a real scraper.
 *
 * @param {DataSource} source
 * @returns {DataSource}
 */
export function createAdapter(source) {
  return {
    getAssignments: (params) => source.getAssignments(params),
    getGrades: (params) => source.getGrades(params),
    getSchedule: (params) => source.getSchedule(params),
    getAnnouncements: (params) => source.getAnnouncements(params),
    getExams: (params) => source.getExams(params),
    getContent: (params) => source.getContent(params),
    getAssignmentDetails: (params) => source.getAssignmentDetails(params),
    downloadFiles: (params) => source.downloadFiles(params),
    whatIfGrade: (params) => source.whatIfGrade(params),
    getDeadlines: (params) => source.getDeadlines(params),
    getUniversityCalendar: (params) => source.getUniversityCalendar(params),
    getSyllabus: (params) => source.getSyllabus(params),
    getGroupMembers: (params) => source.getGroupMembers(params),
    searchAssignments: (params) => source.searchAssignments(params),
    submitAssignment: (params) => source.submitAssignment(params),
  };
}
