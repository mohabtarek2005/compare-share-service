const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  compareTimetables,
  countFreeDays,
  totalGapMinutes,
  earliestStart,
  latestEnd
} = require('../src/compare');
const { getClassMeetings } = require('../src/compareAssumptions');
const { getSampleTimetables } = require('./fixtures/sampleTimetables');

function errorCodes(result) {
  return result.errors.map((error) => error.code);
}

function rankOrder(result) {
  return result.results.map((r) => `${r.rank}:${r.timetableId}`);
}

function singleClassTimetable(id, meeting) {
  return {
    id,
    stale: false,
    missingSectionIds: [],
    sections: [{ sectionId: `${id}-S1`, courseCode: 'CS101', type: 'LECTURE', meetings: [meeting] }]
  };
}

describe('metrics', () => {
  test('free days count teaching days with no classes', () => {
    const { optionA, optionB, optionC } = getSampleTimetables();
    // seven-day week (Sunday-Saturday)
    assert.equal(countFreeDays(getClassMeetings(optionA)), 3);
    assert.equal(countFreeDays(getClassMeetings(optionB)), 5);
    assert.equal(countFreeDays(getClassMeetings(optionC)), 4);
  });

  test('total gaps add up waiting time between classes on each day', () => {
    const { optionA, optionC } = getSampleTimetables();
    assert.equal(totalGapMinutes(getClassMeetings(optionA)), 120);
    assert.equal(totalGapMinutes(getClassMeetings(optionC)), 150);
  });

  test('adjacent classes (one ends when the next starts) give a 0 minute gap', () => {
    const { optionB } = getSampleTimetables();
    assert.equal(totalGapMinutes(getClassMeetings(optionB)), 0);
  });

  test('time before the first class and after the last class is not a gap', () => {
    const meetings = [{ day: 'SUN', startTime: '08:00', endTime: '09:00', sectionId: 'X' }];
    assert.equal(totalGapMinutes(meetings), 0);
  });

  test('gaps on different days are not joined together', () => {
    const meetings = [
      { day: 'SUN', startTime: '08:00', endTime: '09:00', sectionId: 'X' },
      { day: 'MON', startTime: '15:00', endTime: '16:00', sectionId: 'Y' }
    ];
    assert.equal(totalGapMinutes(meetings), 0);
  });

  test('unsorted class lists give the same gap as sorted ones', () => {
    const meetings = [
      { day: 'SUN', startTime: '13:00', endTime: '14:00', sectionId: 'C' },
      { day: 'SUN', startTime: '08:00', endTime: '09:00', sectionId: 'A' },
      { day: 'SUN', startTime: '10:00', endTime: '11:00', sectionId: 'B' }
    ];
    assert.equal(totalGapMinutes(meetings), 60 + 120);
  });

  test('earliest start and latest end across the whole week', () => {
    const { optionA, optionB, optionC } = getSampleTimetables();
    assert.equal(earliestStart(getClassMeetings(optionA)), '09:00');
    assert.equal(latestEnd(getClassMeetings(optionA)), '14:00');
    assert.equal(earliestStart(getClassMeetings(optionB)), '09:00');
    assert.equal(latestEnd(getClassMeetings(optionB)), '13:30');
    assert.equal(earliestStart(getClassMeetings(optionC)), '11:00');
    assert.equal(latestEnd(getClassMeetings(optionC)), '17:00');
  });

  test('metric functions handle an empty schedule without NaN or Infinity', () => {
    assert.equal(countFreeDays([]), 7);
    assert.equal(totalGapMinutes([]), 0);
    assert.equal(earliestStart([]), null);
    assert.equal(latestEnd([]), null);
  });
});

describe('compareTimetables results and ranking', () => {
  test('returns metrics for every timetable', () => {
    const { optionA, optionB } = getSampleTimetables();
    const result = compareTimetables([optionA, optionB], 'mostFreeDays');
    assert.equal(result.ok, true);
    const a = result.results.find((r) => r.timetableId === 'tt-a');
    assert.deepEqual(a.metrics, {
      freeDays: 3,
      totalGapMinutes: 120,
      earliestStart: '09:00',
      latestEnd: '14:00'
    });
    assert.equal(a.name, 'Option A');
  });

  test('ranks by most free days', () => {
    const { optionA, optionB, optionC } = getSampleTimetables();
    const result = compareTimetables([optionA, optionB, optionC], 'mostFreeDays');
    assert.deepEqual(rankOrder(result), ['1:tt-b', '2:tt-c', '3:tt-a']);
  });

  test('ranks by least total gaps', () => {
    const { optionA, optionB, optionC } = getSampleTimetables();
    const result = compareTimetables([optionA, optionB, optionC], 'leastGaps');
    assert.deepEqual(rankOrder(result), ['1:tt-b', '2:tt-a', '3:tt-c']);
  });

  test('ranks by latest earliest start, with ties sharing a rank', () => {
    const { optionA, optionB, optionC } = getSampleTimetables();
    const result = compareTimetables([optionA, optionB, optionC], 'latestStart');
    // A and B both start at 09:00, so they tie for second place.
    assert.deepEqual(rankOrder(result), ['1:tt-c', '2:tt-a', '2:tt-b']);
  });

  test('ranks by earliest latest end', () => {
    const { optionA, optionB, optionC } = getSampleTimetables();
    const result = compareTimetables([optionA, optionB, optionC], 'earliestEnd');
    assert.deepEqual(rankOrder(result), ['1:tt-b', '2:tt-a', '3:tt-c']);
  });

  test('ties are broken by timetable id, whatever the input order', () => {
    const first = singleClassTimetable('tt-2', { day: 'SUN', startTime: '09:00', endTime: '10:00' });
    const second = singleClassTimetable('tt-1', { day: 'SUN', startTime: '09:00', endTime: '10:00' });
    const third = singleClassTimetable('tt-3', { day: 'SUN', startTime: '09:00', endTime: '10:00' });

    for (const criterion of ['mostFreeDays', 'leastGaps', 'latestStart', 'earliestEnd']) {
      const forward = compareTimetables([first, second, third], criterion);
      const backward = compareTimetables([third, second, first], criterion);
      assert.deepEqual(rankOrder(forward), ['1:tt-1', '1:tt-2', '1:tt-3']);
      assert.deepEqual(rankOrder(backward), rankOrder(forward));
    }
  });

  test('accepts exactly 2 and exactly 5 timetables', () => {
    const { optionA, optionB, optionC } = getSampleTimetables();
    assert.equal(compareTimetables([optionA, optionB], 'leastGaps').ok, true);

    const optionD = { ...structuredClone(optionA), id: 'tt-d' };
    const optionE = { ...structuredClone(optionB), id: 'tt-e' };
    const result = compareTimetables([optionA, optionB, optionC, optionD, optionE], 'leastGaps');
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 5);
  });

  test('does not change the timetables passed in', () => {
    const { optionA, optionC } = getSampleTimetables();
    const before = structuredClone([optionA, optionC]);
    compareTimetables([optionA, optionC], 'earliestEnd');
    assert.deepEqual([optionA, optionC], before);
  });
});

describe('compareTimetables input validation', () => {
  test('rejects fewer than 2 timetables', () => {
    const { optionA } = getSampleTimetables();
    assert.deepEqual(errorCodes(compareTimetables([optionA], 'leastGaps')), ['INVALID_TIMETABLE_COUNT']);
    assert.deepEqual(errorCodes(compareTimetables([], 'leastGaps')), ['INVALID_TIMETABLE_COUNT']);
  });

  test('rejects more than 5 timetables', () => {
    const { optionA } = getSampleTimetables();
    const six = ['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => ({ ...structuredClone(optionA), id }));
    const result = compareTimetables(six, 'leastGaps');
    assert.equal(result.ok, false);
    assert.deepEqual(errorCodes(result), ['INVALID_TIMETABLE_COUNT']);
  });

  test('rejects input that is not a list', () => {
    assert.deepEqual(errorCodes(compareTimetables(null, 'leastGaps')), ['INVALID_INPUT']);
    assert.deepEqual(errorCodes(compareTimetables({ id: 'tt-a' }, 'leastGaps')), ['INVALID_INPUT']);
  });

  test('rejects an unknown ranking criterion', () => {
    const { optionA, optionB } = getSampleTimetables();
    assert.deepEqual(errorCodes(compareTimetables([optionA, optionB], 'cheapest')), ['INVALID_CRITERION']);
    assert.deepEqual(errorCodes(compareTimetables([optionA, optionB])), ['INVALID_CRITERION']);
  });

  test('detects duplicate timetable ids, so ["tt-a", "tt-a"] cannot pass as 2 timetables', () => {
    const { optionA } = getSampleTimetables();
    const result = compareTimetables([optionA, structuredClone(optionA)], 'leastGaps');
    assert.equal(result.ok, false);
    assert.deepEqual(errorCodes(result), ['DUPLICATE_TIMETABLE_ID']);
    assert.equal(result.errors[0].timetableId, 'tt-a');
  });

  test('rejects a timetable with a missing id', () => {
    const { optionA, optionB } = getSampleTimetables();
    delete optionB.id;
    assert.deepEqual(errorCodes(compareTimetables([optionA, optionB], 'leastGaps')), ['MISSING_FIELD']);
  });

  test('rejects a timetable that is missing its sections list', () => {
    const { optionA, optionB } = getSampleTimetables();
    delete optionB.sections;
    assert.deepEqual(errorCodes(compareTimetables([optionA, optionB], 'leastGaps')), ['MISSING_FIELD']);
  });

  test('rejects sections with missing fields', () => {
    const { optionA, optionB } = getSampleTimetables();
    delete optionB.sections[0].sectionId;
    optionB.sections[1].meetings = [];
    const result = compareTimetables([optionA, optionB], 'leastGaps');
    assert.deepEqual(errorCodes(result), ['MISSING_FIELD', 'MISSING_FIELD']);
  });

  test('rejects an empty timetable', () => {
    const { optionA, optionB } = getSampleTimetables();
    optionB.sections = [];
    const result = compareTimetables([optionA, optionB], 'leastGaps');
    assert.deepEqual(errorCodes(result), ['EMPTY_TIMETABLE']);
    assert.equal(result.errors[0].timetableId, 'tt-b');
  });

  test('rejects a timetable marked stale', () => {
    const { optionA, optionB } = getSampleTimetables();
    optionB.stale = true;
    assert.deepEqual(errorCodes(compareTimetables([optionA, optionB], 'leastGaps')), ['STALE_TIMETABLE']);
  });

  test('rejects a timetable with missing (deleted) sections, even if it is now empty', () => {
    const { optionA, optionB } = getSampleTimetables();
    optionB.missingSectionIds = ['MATH201-L2'];
    optionB.sections = [];
    assert.deepEqual(errorCodes(compareTimetables([optionA, optionB], 'leastGaps')), ['STALE_TIMETABLE']);
  });

  test('rejects invalid day values', () => {
    const { optionA, optionB } = getSampleTimetables();
    for (const badDay of ['XYZ', 'FRIDAY', 'sun', 'Sunday', '', undefined, 3]) {
      optionB.sections[0].meetings[0].day = badDay;
      const result = compareTimetables([optionA, optionB], 'leastGaps');
      assert.deepEqual(errorCodes(result), ['INVALID_DAY'], `day ${badDay} should be rejected`);
    }
  });

  test('rejects invalid time formats', () => {
    const { optionA, optionB } = getSampleTimetables();
    for (const badTime of ['9:00', '24:00', '09:60', '0900', '09:00am', '', null, 900]) {
      optionB.sections[0].meetings[0].startTime = badTime;
      const result = compareTimetables([optionA, optionB], 'leastGaps');
      assert.deepEqual(errorCodes(result), ['INVALID_TIME'], `time ${badTime} should be rejected`);
    }
  });

  test('accepts boundary times 00:00 and 23:59', () => {
    const early = singleClassTimetable('tt-early', { day: 'SUN', startTime: '00:00', endTime: '01:00' });
    const late = singleClassTimetable('tt-late', { day: 'SUN', startTime: '22:59', endTime: '23:59' });
    const result = compareTimetables([early, late], 'earliestEnd');
    assert.equal(result.ok, true);
    assert.deepEqual(rankOrder(result), ['1:tt-early', '2:tt-late']);
  });

  test('rejects a class whose start time equals its end time', () => {
    const { optionA } = getSampleTimetables();
    const bad = singleClassTimetable('tt-bad', { day: 'SUN', startTime: '10:00', endTime: '10:00' });
    assert.deepEqual(errorCodes(compareTimetables([optionA, bad], 'leastGaps')), ['INVALID_TIME_RANGE']);
  });

  test('rejects a class whose start time is after its end time', () => {
    const { optionA } = getSampleTimetables();
    const bad = singleClassTimetable('tt-bad', { day: 'SUN', startTime: '11:00', endTime: '10:00' });
    assert.deepEqual(errorCodes(compareTimetables([optionA, bad], 'leastGaps')), ['INVALID_TIME_RANGE']);
  });

  test('rejects overlapping classes on the same day', () => {
    const { optionA, optionB } = getSampleTimetables();
    // CS101-B2 normally runs SUN 10:30-12:00; move it so it overlaps the 09:00-10:30 lecture.
    optionB.sections[1].meetings[0].startTime = '10:00';
    const result = compareTimetables([optionA, optionB], 'leastGaps');
    assert.deepEqual(errorCodes(result), ['OVERLAPPING_CLASSES']);
    assert.match(result.errors[0].message, /CS101-L1 and CS101-B2 overlap on SUN/);
  });

  test('does not treat adjacent classes as overlapping', () => {
    const { optionA, optionB } = getSampleTimetables();
    assert.equal(compareTimetables([optionA, optionB], 'leastGaps').ok, true);
  });

  test('same times on different days are not an overlap', () => {
    const { optionA } = getSampleTimetables();
    const timetable = singleClassTimetable('tt-x', { day: 'SUN', startTime: '09:00', endTime: '10:00' });
    timetable.sections[0].meetings.push({ day: 'MON', startTime: '09:00', endTime: '10:00' });
    assert.equal(compareTimetables([optionA, timetable], 'leastGaps').ok, true);
  });

  test('rejects a stale value that is not a boolean', () => {
    for (const badStale of ['true', 'false', 1, 0, null, {}]) {
      const { optionA, optionB } = getSampleTimetables();
      optionB.stale = badStale;
      const result = compareTimetables([optionA, optionB], 'leastGaps');
      assert.deepEqual(errorCodes(result), ['INVALID_FIELD'], `stale ${JSON.stringify(badStale)} should be rejected`);
      assert.equal(result.errors[0].timetableId, 'tt-b');
    }
  });

  test('accepts stale: false and a timetable with no stale field', () => {
    const { optionA, optionB } = getSampleTimetables();
    optionA.stale = false;
    delete optionB.stale;
    assert.equal(compareTimetables([optionA, optionB], 'leastGaps').ok, true);
  });

  test('rejects missingSectionIds that is not a list of section ids', () => {
    const badValues = ['MATH201-L2', '', {}, { id: 'MATH201-L2' }, 5, null, [''], ['  '], [42], ['MATH201-L2', null]];
    for (const badValue of badValues) {
      const { optionA, optionB } = getSampleTimetables();
      optionB.missingSectionIds = badValue;
      const result = compareTimetables([optionA, optionB], 'leastGaps');
      assert.deepEqual(errorCodes(result), ['INVALID_FIELD'], `missingSectionIds ${JSON.stringify(badValue)} should be rejected`);
    }
  });

  test('accepts an empty missingSectionIds list and a timetable without the field', () => {
    const { optionA, optionB } = getSampleTimetables();
    optionA.missingSectionIds = [];
    delete optionB.missingSectionIds;
    assert.equal(compareTimetables([optionA, optionB], 'leastGaps').ok, true);
  });

  test('still treats a valid, non-empty missingSectionIds list as stale', () => {
    const { optionA, optionB } = getSampleTimetables();
    optionB.missingSectionIds = ['MATH201-L2'];
    assert.deepEqual(errorCodes(compareTimetables([optionA, optionB], 'leastGaps')), ['STALE_TIMETABLE']);
  });

  test('rejects a name that is not a string', () => {
    for (const badName of [{}, ['Option B'], 42, null, true]) {
      const { optionA, optionB } = getSampleTimetables();
      optionB.name = badName;
      const result = compareTimetables([optionA, optionB], 'leastGaps');
      assert.deepEqual(errorCodes(result), ['INVALID_FIELD'], `name ${JSON.stringify(badName)} should be rejected`);
    }
  });

  test('accepts a timetable without a name and returns name as null', () => {
    const { optionA, optionB } = getSampleTimetables();
    delete optionB.name;
    const result = compareTimetables([optionA, optionB], 'leastGaps');
    assert.equal(result.ok, true);
    assert.equal(result.results.find((r) => r.timetableId === 'tt-b').name, null);
  });

  test('reports problems from several timetables together', () => {
    const { optionA, optionB, optionC } = getSampleTimetables();
    optionA.stale = true;
    optionC.sections = [];
    const result = compareTimetables([optionA, optionB, optionC], 'leastGaps');
    assert.equal(result.ok, false);
    assert.deepEqual(errorCodes(result), ['STALE_TIMETABLE', 'EMPTY_TIMETABLE']);
  });
});

describe('section text fields and length limits', () => {
  test('rejects a courseCode or type that is not a string', () => {
    for (const field of ['courseCode', 'type']) {
      for (const badValue of [42, true, [], {}, '   ']) {
        const { optionA, optionB } = getSampleTimetables();
        optionB.sections[0][field] = badValue;
        const result = compareTimetables([optionA, optionB], 'leastGaps');
        assert.deepEqual(errorCodes(result), ['INVALID_FIELD'], `${field} ${JSON.stringify(badValue)} should be rejected`);
      }
    }
  });

  test('rejects an empty or missing courseCode or type', () => {
    for (const field of ['courseCode', 'type']) {
      for (const emptyValue of ['', null, undefined]) {
        const { optionA, optionB } = getSampleTimetables();
        optionB.sections[0][field] = emptyValue;
        const result = compareTimetables([optionA, optionB], 'leastGaps');
        assert.deepEqual(errorCodes(result), ['MISSING_FIELD'], `${field} ${JSON.stringify(emptyValue)} should be rejected`);
      }
    }
  });

  test('accepts text fields at their length limits and rejects one character more', () => {
    const limits = [
      ['courseCode', 50],
      ['type', 50],
      ['sectionId', 100]
    ];
    for (const [field, limit] of limits) {
      const atLimit = getSampleTimetables();
      atLimit.optionB.sections[0][field] = 'x'.repeat(limit);
      assert.equal(compareTimetables([atLimit.optionA, atLimit.optionB], 'leastGaps').ok, true, `${field} at ${limit}`);

      const overLimit = getSampleTimetables();
      overLimit.optionB.sections[0][field] = 'x'.repeat(limit + 1);
      assert.deepEqual(errorCodes(compareTimetables([overLimit.optionA, overLimit.optionB], 'leastGaps')), ['INVALID_FIELD']);
    }
  });

  test('timetable names: optional, up to 200 characters', () => {
    const { optionA, optionB } = getSampleTimetables();
    optionA.name = 'n'.repeat(200);
    optionB.name = '';
    assert.equal(compareTimetables([optionA, optionB], 'leastGaps').ok, true);

    optionA.name = 'n'.repeat(201);
    assert.deepEqual(errorCodes(compareTimetables([optionA, optionB], 'leastGaps')), ['INVALID_FIELD']);
  });

  test('metrics and ranking are unchanged for valid timetables', () => {
    const { optionA, optionB, optionC } = getSampleTimetables();
    const result = compareTimetables([optionA, optionB, optionC], 'mostFreeDays');
    assert.deepEqual(rankOrder(result), ['1:tt-b', '2:tt-c', '3:tt-a']);
  });
});
