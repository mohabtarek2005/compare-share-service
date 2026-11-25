// Tests for the Timetable Service adapter (normalizeTimetable in
// src/integrationAssumptions.js). The base fixture is a REAL response captured
// from Yehia's service (commit 01c6397, DEP_MODE=live, Mohamed's Catalogue),
// with the owner id replaced by a placeholder.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTimetable } = require('../src/integrationAssumptions');
const { validateTimetable, compareTimetables } = require('../src/compare');

function realResponse() {
  return {
    id: 'tt-real-plan-b',
    ownerId: 'student-1',
    name: 'Final Retest Plan B',
    createdAt: '2026-11-25T13:23:21.502Z',
    sectionIds: ['3630c41b-f54c-4f67-92d7-2ed5ed70713e', 'c7c8e733-f433-424c-8d63-46b59bbfe923', 'c1cf1462-30c5-4ae1-b325-95104a6b9efc', 'ea35fd42-1735-421d-9020-b2630ece5a11'],
    sections: [
      { id: '3630c41b-f54c-4f67-92d7-2ed5ed70713e', courseId: '1dd8f9ba-c1c2-48e2-ac11-12b67d62b6f0', courseCode: 'TST401', courseTitle: 'Integration Test Course A', sectionCode: 'L2', type: 'lecture', status: 'ACTIVE',
        times: [{ day: 'Sun', start: '12:00', end: '13:00', room: 'T-105' }, { day: 'Tue', start: '09:00', end: '10:00', room: 'T-105' }] },
      { id: 'c7c8e733-f433-424c-8d63-46b59bbfe923', courseId: '1dd8f9ba-c1c2-48e2-ac11-12b67d62b6f0', courseCode: 'TST401', courseTitle: 'Integration Test Course A', sectionCode: 'B1', type: 'lab', status: 'ACTIVE',
        times: [{ day: 'Tue', start: '11:00', end: '12:30', room: 'T-102' }] },
      { id: 'c1cf1462-30c5-4ae1-b325-95104a6b9efc', courseId: '06cb6bdc-0ee3-4d53-ac8b-6dd98a2176b4', courseCode: 'TST402', courseTitle: 'Integration Test Course B', sectionCode: 'L1', type: 'lecture', status: 'ACTIVE',
        times: [{ day: 'Mon', start: '10:00', end: '11:30', room: 'T-103' }] },
      { id: 'ea35fd42-1735-421d-9020-b2630ece5a11', courseId: '06cb6bdc-0ee3-4d53-ac8b-6dd98a2176b4', courseCode: 'TST402', courseTitle: 'Integration Test Course B', sectionCode: 'T1', type: 'tutorial', status: 'ACTIVE',
        times: [{ day: 'Wed', start: '13:00', end: '14:00', room: 'T-104' }] }
    ],
    missingSectionIds: [],
    archivedSectionIds: [],
    stale: false
  };
}

describe('Timetable adapter - real response from Yehia 01c6397', () => {
  test('maps sections to the internal shape and keeps every meeting', () => {
    const result = normalizeTimetable(realResponse());
    assert.equal(result.ok, true);
    const t = result.timetable;
    assert.equal(t.id, 'tt-real-plan-b');
    assert.equal(t.ownerId, 'student-1');
    assert.equal(t.name, 'Final Retest Plan B');
    assert.equal(t.stale, false);
    assert.deepEqual(t.missingSectionIds, []);
    assert.deepEqual(t.sections[0], {
      sectionId: '3630c41b-f54c-4f67-92d7-2ed5ed70713e',
      courseCode: 'TST401',
      type: 'lecture',
      meetings: [
        { day: 'SUN', startTime: '12:00', endTime: '13:00' },
        { day: 'TUE', startTime: '09:00', endTime: '10:00' }
      ]
    });
    assert.deepEqual(t.sections.map((s) => s.type), ['lecture', 'lab', 'lecture', 'tutorial']);
    assert.equal(t.sections.reduce((n, s) => n + s.meetings.length, 0), 5);
  });

  test('the normalized timetable passes validation and compares', () => {
    const { timetable } = normalizeTimetable(realResponse());
    assert.deepEqual(validateTimetable(timetable), []);
    const result = compareTimetables([timetable, { ...timetable, id: 'copy' }], 'leastGaps');
    assert.equal(result.ok, true);
    // Sun 12-13, Mon 10-11:30, Tue 09-10 + 11-12:30 (gap 60), Wed 13-14 -> 4 days used,
    // free days Thu, Fri, Sat in the seven-day week
    assert.deepEqual(result.results[0].metrics, { freeDays: 3, totalGapMinutes: 60, earliestStart: '09:00', latestEnd: '14:00' });
  });

  test('day names are case-insensitive', () => {
    const body = realResponse();
    body.sections[1].times[0].day = 'TUE';
    body.sections[2].times[0].day = 'mon';
    const { timetable } = normalizeTimetable(body);
    assert.equal(timetable.sections[1].meetings[0].day, 'TUE');
    assert.equal(timetable.sections[2].meetings[0].day, 'MON');
  });
});

describe('Timetable adapter - seven-day week, outdated and malformed data', () => {
  test('Friday and Saturday meetings are mapped and counted, none dropped', () => {
    const body = realResponse();
    body.sections[3].times.push({ day: 'Fri', start: '10:00', end: '11:00' });
    body.sections[1].times[0].day = 'Sat';
    const result = normalizeTimetable(body);
    assert.equal(result.ok, true);
    assert.equal(result.timetable.sections[1].meetings[0].day, 'SAT');
    assert.deepEqual(result.timetable.sections[3].meetings.map((m) => m.day), ['WED', 'FRI']);
    assert.deepEqual(validateTimetable(result.timetable), []);
    // used: Sun, Mon, Tue (09-10), Wed, Fri, Sat -> 1 free day (Thu)
    const compared = compareTimetables([result.timetable, { ...result.timetable, id: 'copy' }], 'mostFreeDays');
    assert.equal(compared.results[0].metrics.freeDays, 1);
  });

  test('stale, missing and archived sections make the timetable stale (409 later)', () => {
    const cases = [
      (b) => (b.stale = true),
      (b) => (b.missingSectionIds = ['gone-1']),
      (b) => (b.archivedSectionIds = ['c7c8e733-f433-424c-8d63-46b59bbfe923']),
      (b) => (b.sections[1].status = 'ARCHIVED')
    ];
    for (const change of cases) {
      const body = realResponse();
      change(body);
      const result = normalizeTimetable(body);
      assert.equal(result.ok, true);
      assert.equal(validateTimetable(result.timetable)[0].code, 'STALE_TIMETABLE');
    }
  });

  test('malformed or unexpected data is refused (502 later), and type is never inferred', () => {
    const cases = [
      (b) => delete b.sections,
      (b) => (b.sections = 'x'),
      (b) => delete b.sections[0].type,
      (b) => (b.sections[0].type = ''),
      (b) => delete b.sections[0].courseCode,
      (b) => delete b.sections[0].id,
      (b) => (b.sections[0].id = 42),
      (b) => delete b.sections[0].times,
      (b) => (b.sections[0].times = []),
      (b) => (b.sections[0].times[0] = 'Sun 12:00'),
      (b) => (b.sections[0].times[1].day = 'Someday'),
      (b) => (b.sections[0].times[1].day = 0),
      (b) => delete b.sections[0].times[0].start,
      (b) => (b.sections[0].status = 1),
      (b) => (b.stale = 'false'),
      (b) => (b.missingSectionIds = 'none'),
      (b) => (b.archivedSectionIds = [1]),
      (b) => { b.sections[0].dayOfWeek = 0; delete b.sections[0].times; } // old flat Catalogue form
    ];
    for (const change of cases) {
      const body = realResponse();
      change(body);
      assert.equal(normalizeTimetable(body).ok, false, String(change));
    }
    for (const body of [null, [], 'text', 42]) {
      assert.equal(normalizeTimetable(body).ok, false);
    }
  });

  test('only the fields the comparison needs are passed on', () => {
    const { timetable } = normalizeTimetable(realResponse());
    assert.deepEqual(Object.keys(timetable).sort(), ['id', 'missingSectionIds', 'name', 'ownerId', 'sections', 'stale']);
    assert.deepEqual(Object.keys(timetable.sections[0]).sort(), ['courseCode', 'meetings', 'sectionId', 'type']);
  });
});
