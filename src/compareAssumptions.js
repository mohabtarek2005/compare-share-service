// UNCONFIRMED ASSUMPTIONS FOR THE COMPARISON LOGIC
//
// Nothing in this file is an agreed team contract yet. These values were chosen
// so the comparison logic can be built and tested before the Timetable Service
// exists. Check each one with Yehia (Timetable) and Mohamed (Catalogue) and
// update this file only, so the rest of the code does not need to change.

// 1. Teaching days. Assumed Sunday to Thursday (Egyptian university week).
//    Day values must match these strings exactly.
const TEACHING_DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU'];

// 2. Time format. Assumed 24-hour "HH:MM" strings, e.g. "09:00" or "14:30".
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

// 3. How many timetables can be compared at once (from the Phase 2 plan).
const MIN_TIMETABLES = 2;
const MAX_TIMETABLES = 5;

// 3b. Length limits for text fields (generous, to reject absurd data only).
//     courseCode and type are required non-empty strings; name is optional.
const MAX_TIMETABLE_NAME_LENGTH = 200;
const MAX_SECTION_ID_LENGTH = 100;
const MAX_COURSE_CODE_LENGTH = 50;
const MAX_SECTION_TYPE_LENGTH = 50;

// 4. Shape of one saved timetable, as we expect to receive it from the
//    Timetable Service:
//
//    {
//      id: 'tt-1',
//      name: 'Option A',                 // optional
//      stale: false,                     // true when a section was edited or deleted
//      missingSectionIds: [],            // sections that no longer exist
//      sections: [
//        {
//          sectionId: 'CS101-L1',
//          courseCode: 'CS101',
//          type: 'LECTURE',
//          meetings: [{ day: 'SUN', startTime: '09:00', endTime: '10:30' }]
//        }
//      ]
//    }
//
//    getClassMeetings() is the only function that reads this shape. If the
//    real Timetable Service sends something different, change it here.
function getClassMeetings(timetable) {
  const meetings = [];
  for (const section of timetable.sections) {
    for (const meeting of section.meetings) {
      meetings.push({
        sectionId: section.sectionId,
        day: meeting.day,
        startTime: meeting.startTime,
        endTime: meeting.endTime
      });
    }
  }
  return meetings;
}

// 5. Stale timetables. Assumed rule: a timetable is outdated when
//    stale === true OR missingSectionIds is not empty. Outdated timetables are
//    rejected from comparison, because their metrics would be wrong.
function isStale(timetable) {
  const hasMissingSections =
    Array.isArray(timetable.missingSectionIds) && timetable.missingSectionIds.length > 0;
  return timetable.stale === true || hasMissingSections;
}

module.exports = {
  TEACHING_DAYS,
  TIME_PATTERN,
  MIN_TIMETABLES,
  MAX_TIMETABLES,
  MAX_TIMETABLE_NAME_LENGTH,
  MAX_SECTION_ID_LENGTH,
  MAX_COURSE_CODE_LENGTH,
  MAX_SECTION_TYPE_LENGTH,
  getClassMeetings,
  isStale
};
