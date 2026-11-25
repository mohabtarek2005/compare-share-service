const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateTermSettings,
  buildTimetableCalendar,
  calendarFileName,
  escapeText,
  foldLine,
  utcOffsetMinutes,
  localToUtc,
  findOffsetChanges
} = require('../src/icsCalendar');
const { getSampleTimetables } = require('./fixtures/sampleTimetables');

const NOW = new Date('2026-11-23T10:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
// Test-only term that contains BOTH Cairo daylight-saving changes of 2026
// (24 April and 30 October).
const DST_TERM = validateTermSettings({ termStart: '2026-04-12', termEnd: '2026-11-05' }).settings;

function unfold(ics) {
  return ics.replace(/\r\n /g, '');
}

function contentLines(ics) {
  return unfold(ics).split('\r\n').filter((line) => line !== '');
}

// Returns each VEVENT as an object of property name -> value.
function parseEvents(ics) {
  const events = [];
  let current = null;
  for (const line of contentLines(ics)) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
    } else if (line === 'END:VEVENT') {
      events.push(current);
      current = null;
    } else if (current) {
      const colon = line.indexOf(':');
      current[line.slice(0, colon)] = line.slice(colon + 1);
    }
  }
  return events;
}

// "20260412T090000" -> timestamp whose UTC fields hold that local date and time.
function parseLocal(value) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// Expands one weekly event the way a calendar app would: every 7 days from
// DTSTART while the start (in UTC) is not after UNTIL.
function expandWeekly(event, timeZone) {
  const firstLocal = parseLocal(event['DTSTART;TZID=' + timeZone]);
  const until = parseLocal(event.RRULE.match(/UNTIL=(\w+)/)[1]);
  const occurrences = [];
  for (let local = firstLocal; localToUtc(local, timeZone) <= until; local += 7 * DAY_MS) {
    occurrences.push(local);
  }
  return occurrences;
}

function sampleCalendar(settings = DST_TERM) {
  return buildTimetableCalendar(getSampleTimetables().optionA, settings, NOW);
}

describe('term settings', () => {
  test('accepts valid settings and defaults the time zone to Africa/Cairo', () => {
    const result = validateTermSettings({ termStart: '2026-09-13', termEnd: '2026-12-31' });
    assert.deepEqual(result, {
      ok: true,
      settings: { termStart: '2026-09-13', termEnd: '2026-12-31', timeZone: 'Africa/Cairo' }
    });
  });

  test('rejects missing, badly formatted and impossible dates', () => {
    const cases = [
      {},
      { termStart: '2026-09-13' },
      { termStart: '13/09/2026', termEnd: '2026-12-31' },
      { termStart: '2026-02-30', termEnd: '2026-12-31' },
      { termStart: '2026-09-13', termEnd: '2026-13-01' },
      { termStart: 20260913, termEnd: '2026-12-31' }
    ];
    for (const settings of cases) {
      assert.equal(validateTermSettings(settings).ok, false, JSON.stringify(settings));
    }
  });

  test('rejects an end date before the start date and terms over 366 days', () => {
    assert.match(validateTermSettings({ termStart: '2026-12-31', termEnd: '2026-09-13' }).error, /before/);
    assert.match(validateTermSettings({ termStart: '2026-01-01', termEnd: '2027-01-03' }).error, /366/);
    assert.equal(validateTermSettings({ termStart: '2026-09-13', termEnd: '2026-09-13' }).ok, true);
  });

  test('rejects an unknown time zone', () => {
    for (const timeZone of ['Mars/Olympus', '', 'UTC+2']) {
      assert.equal(validateTermSettings({ termStart: '2026-09-13', termEnd: '2026-12-31', timeZone }).ok, false);
    }
  });
});

describe('time zone handling (from Node\'s built-in time zone data)', () => {
  test('Cairo is UTC+2 in winter and UTC+3 in summer (daylight saving)', () => {
    assert.equal(utcOffsetMinutes(Date.parse('2026-01-15T12:00:00Z'), 'Africa/Cairo'), 120);
    assert.equal(utcOffsetMinutes(Date.parse('2026-07-15T12:00:00Z'), 'Africa/Cairo'), 180);
    assert.equal(utcOffsetMinutes(Date.parse('2026-07-15T12:00:00Z'), 'Asia/Kolkata'), 330);
    assert.equal(utcOffsetMinutes(Date.parse('2026-07-15T12:00:00Z'), 'UTC'), 0);
  });

  test('finds the exact moments Cairo changes its clocks in 2026', () => {
    const changes = findOffsetChanges(Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-12-31T00:00:00Z'), 'Africa/Cairo');
    assert.deepEqual(changes, [
      { instant: Date.parse('2026-04-23T22:00:00Z'), offsetFrom: 120, offsetTo: 180 },
      { instant: Date.parse('2026-10-29T21:00:00Z'), offsetFrom: 180, offsetTo: 120 }
    ]);
  });

  test('a 09:00 Thursday class keeps its local time across both changes', () => {
    const cases = [
      ['2026-04-23', '2026-04-23T07:00:00.000Z'], // last Thursday before summer time (UTC+2)
      ['2026-04-30', '2026-04-30T06:00:00.000Z'], // first Thursday in summer time (UTC+3)
      ['2026-10-29', '2026-10-29T06:00:00.000Z'], // still summer time until midnight
      ['2026-11-05', '2026-11-05T07:00:00.000Z'] // back to UTC+2
    ];
    for (const [date, expectedUtc] of cases) {
      const local = Date.parse(`${date}T09:00:00Z`);
      assert.equal(new Date(localToUtc(local, 'Africa/Cairo')).toISOString(), expectedUtc, date);
    }
  });

  test('VTIMEZONE holds the real Cairo offsets for the term, not a fixed +0200', () => {
    const ics = sampleCalendar();
    const block = ics.slice(ics.indexOf('BEGIN:VTIMEZONE'), ics.indexOf('END:VTIMEZONE') + 'END:VTIMEZONE'.length);
    assert.equal(block, [
      'BEGIN:VTIMEZONE',
      'TZID:Africa/Cairo',
      'BEGIN:STANDARD', 'DTSTART:20260411T000000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0200', 'END:STANDARD',
      'BEGIN:DAYLIGHT', 'DTSTART:20260424T000000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0300', 'END:DAYLIGHT',
      'BEGIN:STANDARD', 'DTSTART:20261030T000000', 'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0200', 'END:STANDARD',
      'END:VTIMEZONE'
    ].join('\r\n'));
  });

  test('a winter-only term has a single observance', () => {
    const settings = validateTermSettings({ termStart: '2026-12-01', termEnd: '2027-01-31' }).settings;
    const ics = sampleCalendar(settings);
    const block = ics.slice(ics.indexOf('BEGIN:VTIMEZONE'), ics.indexOf('END:VTIMEZONE'));
    assert.equal((block.match(/BEGIN:(STANDARD|DAYLIGHT)/g) || []).length, 1);
    assert.match(block, /TZOFFSETTO:\+0200/);
  });

  test('works with another time zone', () => {
    const settings = validateTermSettings({ termStart: '2026-09-13', termEnd: '2026-12-31', timeZone: 'Europe/London' }).settings;
    const ics = sampleCalendar(settings);
    assert.match(ics, /TZID:Europe\/London/);
    assert.match(ics, /DTSTART;TZID=Europe\/London:20260913T090000/);
    assert.match(ics, /TZOFFSETFROM:\+0100\r\nTZOFFSETTO:\+0000/);
  });
});

describe('calendar content', () => {
  test('has the required calendar structure', () => {
    const lines = contentLines(sampleCalendar());
    assert.deepEqual(lines.slice(0, 5), [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Team 38//Class Timetable Builder//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH'
    ]);
    assert.equal(lines[lines.length - 1], 'END:VCALENDAR');
  });

  test('creates one weekly event per meeting, with correct times', () => {
    const events = parseEvents(sampleCalendar());
    assert.equal(events.length, 6);

    const summaries = events.map((e) => `${e.SUMMARY} ${e['DTSTART;TZID=Africa/Cairo']}-${e['DTEND;TZID=Africa/Cairo']}`);
    assert.deepEqual(summaries, [
      'CS101 LECTURE 20260412T090000-20260412T103000', // SUN
      'CS101 LECTURE 20260414T090000-20260414T103000', // TUE
      'CS101 LAB 20260412T110000-20260412T123000', // SUN
      'MATH201 LECTURE 20260413T100000-20260413T113000', // MON
      'MATH201 LECTURE 20260415T100000-20260415T113000', // WED
      'MATH201 TUTORIAL 20260415T130000-20260415T140000' // WED
    ]);
    for (const event of events) {
      assert.equal(event.RRULE, 'RRULE:FREQ=WEEKLY;UNTIL=20261105T215959Z'.slice(6));
      assert.match(event.DTSTAMP, /^20261123T100000Z$/);
    }
    assert.equal(events[0].DESCRIPTION, 'Section: CS101-L1\\nTimetable: Option A');
  });

  test('repeats every week inside the term and never outside it', () => {
    const termStart = Date.parse('2026-04-12T00:00:00Z');
    const termEnd = Date.parse('2026-11-05T00:00:00Z');
    const dayNumbers = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4 };
    const { optionA } = getSampleTimetables();
    const meetings = optionA.sections.flatMap((s) => s.meetings);
    const events = parseEvents(sampleCalendar());

    events.forEach((event, index) => {
      const occurrences = expandWeekly(event, 'Africa/Cairo');
      let expected = 0;
      for (let day = termStart; day <= termEnd; day += DAY_MS) {
        if (new Date(day).getUTCDay() === dayNumbers[meetings[index].day]) expected++;
      }
      assert.equal(occurrences.length, expected);
      const firstDay = Math.floor(occurrences[0] / DAY_MS) * DAY_MS;
      const lastDay = Math.floor(occurrences[occurrences.length - 1] / DAY_MS) * DAY_MS;
      assert.ok(firstDay >= termStart && lastDay <= termEnd);
    });
  });

  test('includes a class on the last day of the term but nothing after it', () => {
    // Term ends on a Thursday; a Thursday class must happen that day.
    const settings = validateTermSettings({ termStart: '2026-10-01', termEnd: '2026-10-29' }).settings;
    const timetable = getSampleTimetables().optionC; // has a THU 16:00-17:00 tutorial
    const events = parseEvents(buildTimetableCalendar(timetable, settings, NOW));
    const thursday = events.find((e) => e['DTSTART;TZID=Africa/Cairo'] === '20261001T160000');
    const occurrences = expandWeekly(thursday, 'Africa/Cairo');
    assert.equal(new Date(occurrences[occurrences.length - 1]).toISOString(), '2026-10-29T16:00:00.000Z');
  });

  test('skips meetings whose weekday never happens in a very short term', () => {
    const settings = validateTermSettings({ termStart: '2026-09-13', termEnd: '2026-09-13' }).settings; // one Sunday
    const events = parseEvents(sampleCalendar(settings));
    assert.deepEqual(events.map((e) => e['DTSTART;TZID=Africa/Cairo']), ['20260913T090000', '20260913T110000']);
  });

  test('UIDs are unique per event and stable between downloads', () => {
    const first = parseEvents(sampleCalendar()).map((e) => e.UID);
    const second = parseEvents(buildTimetableCalendar(getSampleTimetables().optionA, DST_TERM, new Date())).map((e) => e.UID);
    assert.equal(new Set(first).size, first.length);
    assert.deepEqual(first, second);
    for (const uid of first) {
      assert.match(uid, /^[0-9a-f]{32}@class-timetable-builder$/);
    }
  });

  test('does not include fields that are not part of the timetable data', () => {
    const timetable = { ...getSampleTimetables().optionA, ownerId: 'student-a', token: 'secret-share-token' };
    const ics = buildTimetableCalendar(timetable, DST_TERM, NOW);
    assert.doesNotMatch(ics, /student-a|secret-share-token|LOCATION|ORGANIZER|ATTENDEE/);
  });
});

describe('text escaping, Unicode and line folding', () => {
  test('escapes special characters as RFC 5545 requires', () => {
    assert.equal(escapeText('a\\b;c,d'), 'a\\\\b\\;c\\,d');
    assert.equal(escapeText('line1\r\nline2\nline3\rline4'), 'line1\\nline2\\nline3\\nline4');
    assert.equal(escapeText('bad\u0000\u0007\u001b\u007fchars\tok'), 'badchars\tok');
  });

  test('newlines in course data cannot inject new calendar lines', () => {
    const timetable = getSampleTimetables().optionB;
    timetable.sections[0].courseCode = 'CS101\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Injected';
    timetable.name = 'Name;with,special\\chars\nand newline';
    const ics = buildTimetableCalendar(timetable, DST_TERM, NOW);
    const lines = contentLines(ics);
    assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, 6);
    assert.equal(lines.filter((l) => l === 'END:VEVENT').length, 6);
    assert.equal(lines.some((l) => l.startsWith('SUMMARY:Injected')), false);
    assert.ok(lines.includes('SUMMARY:CS101\\nEND:VEVENT\\nBEGIN:VEVENT\\nSUMMARY:Injected LECTURE'));
    assert.ok(lines.some((l) => l.includes('Timetable: Name\\;with\\,special\\\\chars\\nand newline')));
  });

  test('uses CRLF line endings only', () => {
    const ics = sampleCalendar();
    assert.ok(ics.endsWith('\r\n'));
    assert.equal(/[^\r]\n/.test(ics), false);
    assert.equal(/\r[^\n]/.test(ics), false);
  });

  test('folds long lines at 75 bytes without changing the content', () => {
    const line = 'DESCRIPTION:' + 'x'.repeat(200);
    const folded = foldLine(line);
    const parts = folded.split('\r\n');
    assert.ok(parts.length > 1);
    for (const [index, part] of parts.entries()) {
      assert.ok(Buffer.byteLength(part, 'utf8') <= 75);
      if (index > 0) assert.equal(part[0], ' ');
    }
    assert.equal(unfold(folded), line);
    assert.equal(foldLine('SHORT:line'), 'SHORT:line');
  });

  test('Arabic text is folded by bytes without splitting characters', () => {
    const timetable = getSampleTimetables().optionA;
    const arabicCourse = 'برمجة '.repeat(20); // "programming" repeated, 2 bytes per letter
    timetable.sections[0].courseCode = arabicCourse.trim();
    timetable.name = 'جدولي \u{1F4DA}'; // includes a 4-byte emoji
    const ics = buildTimetableCalendar(timetable, DST_TERM, NOW);

    for (const physicalLine of ics.split('\r\n')) {
      const bytes = Buffer.from(physicalLine, 'utf8');
      assert.ok(bytes.length <= 75, 'line too long');
      assert.equal(bytes.toString('utf8').includes('�'), false);
    }
    const events = parseEvents(ics);
    assert.equal(events[0].SUMMARY, `${arabicCourse.trim()} LECTURE`);
    assert.match(events[0].DESCRIPTION, /Timetable: جدولي \u{1F4DA}/u);
  });

  test('builds a safe ASCII download file name', () => {
    assert.equal(calendarFileName({ name: 'Option A' }), 'Option-A.ics');
    assert.equal(calendarFileName({ name: '../"evil"\r\nname' }), 'evil-name.ics');
    assert.equal(calendarFileName({ name: 'جدولي' }), 'timetable.ics');
    assert.equal(calendarFileName({ name: null }), 'timetable.ics');
    assert.equal(calendarFileName({ name: 'x'.repeat(80) }), `${'x'.repeat(50)}.ics`);
  });
});
