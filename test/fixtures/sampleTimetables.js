// Sample saved timetables used only by the tests.
// They follow the unconfirmed shape described in src/compareAssumptions.js.

// Option A: four teaching days, some waiting between classes.
//   SUN 09:00-10:30, 11:00-12:30  -> 30 min gap
//   MON 10:00-11:30
//   TUE 09:00-10:30
//   WED 10:00-11:30, 13:00-14:00  -> 90 min gap
//   free days: THU (1), total gaps: 120, earliest 09:00, latest 14:00
const optionA = {
  id: 'tt-a',
  name: 'Option A',
  stale: false,
  missingSectionIds: [],
  sections: [
    {
      sectionId: 'CS101-L1',
      courseCode: 'CS101',
      type: 'LECTURE',
      meetings: [
        { day: 'SUN', startTime: '09:00', endTime: '10:30' },
        { day: 'TUE', startTime: '09:00', endTime: '10:30' }
      ]
    },
    {
      sectionId: 'CS101-B1',
      courseCode: 'CS101',
      type: 'LAB',
      meetings: [{ day: 'SUN', startTime: '11:00', endTime: '12:30' }]
    },
    {
      sectionId: 'MATH201-L1',
      courseCode: 'MATH201',
      type: 'LECTURE',
      meetings: [
        { day: 'MON', startTime: '10:00', endTime: '11:30' },
        { day: 'WED', startTime: '10:00', endTime: '11:30' }
      ]
    },
    {
      sectionId: 'MATH201-T1',
      courseCode: 'MATH201',
      type: 'TUTORIAL',
      meetings: [{ day: 'WED', startTime: '13:00', endTime: '14:00' }]
    }
  ]
};

// Option B: compact, back-to-back classes on two days.
//   SUN 09:00-10:30, 10:30-12:00, 12:00-13:30  -> adjacent, 0 gap
//   TUE 09:00-10:30, 10:30-12:00, 12:00-13:00  -> adjacent, 0 gap
//   free days: MON, WED, THU (3), total gaps: 0, earliest 09:00, latest 13:30
const optionB = {
  id: 'tt-b',
  name: 'Option B',
  stale: false,
  missingSectionIds: [],
  sections: [
    {
      sectionId: 'CS101-L1',
      courseCode: 'CS101',
      type: 'LECTURE',
      meetings: [
        { day: 'SUN', startTime: '09:00', endTime: '10:30' },
        { day: 'TUE', startTime: '09:00', endTime: '10:30' }
      ]
    },
    {
      sectionId: 'CS101-B2',
      courseCode: 'CS101',
      type: 'LAB',
      meetings: [{ day: 'SUN', startTime: '10:30', endTime: '12:00' }]
    },
    {
      sectionId: 'MATH201-L2',
      courseCode: 'MATH201',
      type: 'LECTURE',
      meetings: [
        { day: 'SUN', startTime: '12:00', endTime: '13:30' },
        { day: 'TUE', startTime: '10:30', endTime: '12:00' }
      ]
    },
    {
      sectionId: 'MATH201-T2',
      courseCode: 'MATH201',
      type: 'TUTORIAL',
      meetings: [{ day: 'TUE', startTime: '12:00', endTime: '13:00' }]
    }
  ]
};

// Option C: late starts. Sections and meetings are deliberately listed out of
// time order to check that the code sorts them itself.
//   MON 11:00-12:30, 14:00-15:30  -> 90 min gap
//   WED 11:00-12:30, 13:00-14:30  -> 30 min gap
//   THU 14:00-15:30, 16:00-17:00  -> 30 min gap
//   free days: SUN, TUE (2), total gaps: 150, earliest 11:00, latest 17:00
const optionC = {
  id: 'tt-c',
  name: 'Option C',
  stale: false,
  missingSectionIds: [],
  sections: [
    {
      sectionId: 'MATH201-T3',
      courseCode: 'MATH201',
      type: 'TUTORIAL',
      meetings: [{ day: 'THU', startTime: '16:00', endTime: '17:00' }]
    },
    {
      sectionId: 'MATH201-L3',
      courseCode: 'MATH201',
      type: 'LECTURE',
      meetings: [
        { day: 'WED', startTime: '13:00', endTime: '14:30' },
        { day: 'MON', startTime: '14:00', endTime: '15:30' }
      ]
    },
    {
      sectionId: 'CS101-B3',
      courseCode: 'CS101',
      type: 'LAB',
      meetings: [{ day: 'THU', startTime: '14:00', endTime: '15:30' }]
    },
    {
      sectionId: 'CS101-L3',
      courseCode: 'CS101',
      type: 'LECTURE',
      meetings: [
        { day: 'WED', startTime: '11:00', endTime: '12:30' },
        { day: 'MON', startTime: '11:00', endTime: '12:30' }
      ]
    }
  ]
};

// Each call returns fresh copies so one test cannot change data used by another.
function getSampleTimetables() {
  return structuredClone({ optionA, optionB, optionC });
}

module.exports = { getSampleTimetables };
