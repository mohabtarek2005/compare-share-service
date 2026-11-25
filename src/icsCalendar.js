// Builds an iCalendar (.ics, RFC 5545) file for a timetable.
//
// This module has no Express or database code, so it can be copied into the
// Timetable Service as well, and both exports stay the same.
//
// How times work:
// - Every class meeting becomes ONE event that repeats weekly
//   (RRULE:FREQ=WEEKLY) from its first day in the term until the end of the term.
// - Times are written as local wall-clock times with TZID (for example
//   Africa/Cairo), so a 09:00 class stays at 09:00 before and after a
//   daylight-saving change.
// - RFC 5545 needs a VTIMEZONE for that TZID. It is NOT hand-written: the UTC
//   offsets and the exact change moments are read from Node's built-in time
//   zone data (Intl), for the dates of the term only.
//
// DATA ASSUMPTION (unconfirmed, same as compareAssumptions.js): a timetable is
// { id, name, sections: [{ sectionId, courseCode, type, meetings: [{ day, startTime, endTime }] }] }
// with day as 'SUN'..'SAT' and times as 'HH:MM'.

const crypto = require('node:crypto');

const PRODUCT_ID = '-//Team 38//Class Timetable Builder//EN';
const UID_DOMAIN = 'class-timetable-builder';
const DEFAULT_TIME_ZONE = 'Africa/Cairo';
const MAX_TERM_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAY_NUMBERS = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

// ---------- Settings ----------

// Parses "YYYY-MM-DD" into a UTC-midnight timestamp, or null if it is not a real date.
function parseDate(text) {
  const match = typeof text === 'string' ? text.match(DATE_PATTERN) : null;
  if (!match) {
    return null;
  }
  const [year, month, day] = match.slice(1).map(Number);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null; // e.g. 2026-02-30
  }
  return time;
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return typeof timeZone === 'string' && timeZone !== '';
  } catch {
    return false;
  }
}

// Checks TERM_START_DATE, TERM_END_DATE and TIMEZONE.
// Returns { ok: true, settings } or { ok: false, error }.
function validateTermSettings({ termStart, termEnd, timeZone = DEFAULT_TIME_ZONE } = {}) {
  const start = parseDate(termStart);
  const end = parseDate(termEnd);
  if (start === null || end === null) {
    return { ok: false, error: 'Term start and end must be real dates in YYYY-MM-DD format' };
  }
  if (end < start) {
    return { ok: false, error: 'Term end must not be before term start' };
  }
  if ((end - start) / DAY_MS > MAX_TERM_DAYS) {
    return { ok: false, error: `The term cannot be longer than ${MAX_TERM_DAYS} days` };
  }
  if (!isValidTimeZone(timeZone)) {
    return { ok: false, error: 'TIMEZONE must be a valid IANA time zone such as Africa/Cairo' };
  }
  return { ok: true, settings: { termStart, termEnd, timeZone } };
}

// ---------- Time zone helpers (built on Intl, no guessed offsets) ----------

const formatterCache = new Map();

function getFormatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }));
  }
  return formatterCache.get(timeZone);
}

// UTC offset of the time zone, in minutes, at the given moment.
function utcOffsetMinutes(instant, timeZone) {
  const parts = {};
  for (const part of getFormatter(timeZone).formatToParts(new Date(instant))) {
    parts[part.type] = Number(part.value);
  }
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  const wholeSeconds = Math.floor(instant / 1000) * 1000;
  return Math.round((localAsUtc - wholeSeconds) / MINUTE_MS);
}

// Converts a local wall-clock time in the time zone to a UTC timestamp.
function localToUtc(dateTime, timeZone) {
  // dateTime is a timestamp whose UTC fields hold the local date and time.
  const firstGuess = dateTime - utcOffsetMinutes(dateTime, timeZone) * MINUTE_MS;
  const offset = utcOffsetMinutes(firstGuess, timeZone);
  return dateTime - offset * MINUTE_MS;
}

function pad(number, length = 2) {
  return String(number).padStart(length, '0');
}

// Formats the UTC fields of a timestamp as YYYYMMDDTHHMMSS.
function formatDateTime(time) {
  const d = new Date(time);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`;
}

// Finds every moment between from and to where the time zone's offset changes.
function findOffsetChanges(from, to, timeZone) {
  const changes = [];
  let previousTime = from;
  let previousOffset = utcOffsetMinutes(from, timeZone);
  for (let time = from + DAY_MS; time <= to + DAY_MS; time += DAY_MS) {
    const offset = utcOffsetMinutes(time, timeZone);
    if (offset !== previousOffset) {
      // Narrow down to the exact minute of the change.
      let low = previousTime;
      let high = time;
      while (high - low > MINUTE_MS) {
        const middle = low + Math.floor((high - low) / 2 / MINUTE_MS) * MINUTE_MS;
        if (utcOffsetMinutes(middle, timeZone) === previousOffset) {
          low = middle;
        } else {
          high = middle;
        }
      }
      changes.push({ instant: high, offsetFrom: previousOffset, offsetTo: offset });
    }
    previousTime = time;
    previousOffset = offset;
  }
  return changes;
}

// VTIMEZONE built from the real offsets during the term (RFC 5545 section 3.6.5).
function buildTimeZoneLines(timeZone, rangeStart, rangeEnd) {
  const year = new Date(rangeStart).getUTCFullYear();
  const standardOffset = Math.min(
    utcOffsetMinutes(Date.UTC(year, 0, 1), timeZone),
    utcOffsetMinutes(Date.UTC(year, 6, 1), timeZone)
  );
  const observance = (offsetFrom, offsetTo, localStart) => {
    const kind = offsetTo > standardOffset ? 'DAYLIGHT' : 'STANDARD';
    return [
      `BEGIN:${kind}`,
      `DTSTART:${formatDateTime(localStart)}`,
      `TZOFFSETFROM:${formatOffset(offsetFrom)}`,
      `TZOFFSETTO:${formatOffset(offsetTo)}`,
      `END:${kind}`
    ];
  };

  const initialOffset = utcOffsetMinutes(rangeStart, timeZone);
  const lines = [`BEGIN:VTIMEZONE`, `TZID:${timeZone}`];
  lines.push(...observance(initialOffset, initialOffset, rangeStart + initialOffset * MINUTE_MS));
  for (const change of findOffsetChanges(rangeStart, rangeEnd, timeZone)) {
    // The observance starts at the local time just before the change.
    lines.push(...observance(change.offsetFrom, change.offsetTo, change.instant + change.offsetFrom * MINUTE_MS));
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

// ---------- Text formatting ----------

// Escapes a TEXT value (RFC 5545 section 3.3.11). Line breaks become "\n" so
// they cannot start a new calendar line, and other control characters are removed.
function escapeText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

// Folds a content line so no line is longer than 75 bytes of UTF-8
// (RFC 5545 section 3.1). Characters are never split in the middle.
function foldLine(line) {
  const parts = [];
  let current = '';
  let currentBytes = 0;
  let limit = 75;
  for (const character of line) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (currentBytes + bytes > limit) {
      parts.push(current);
      current = ' ';
      currentBytes = 1;
      limit = 75;
    }
    current += character;
    currentBytes += bytes;
  }
  parts.push(current);
  return parts.join('\r\n');
}

// ---------- Events ----------

function timeToParts(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return { hours, minutes };
}

// Stable UID: the same class in the same term always gets the same UID, so
// importing a new copy updates events instead of duplicating them. It is a
// hash, so no ids or tokens are shown in it.
function buildUid(timetableId, section, meeting, settings) {
  const key = [timetableId, section.sectionId, meeting.day, meeting.startTime, meeting.endTime,
    settings.termStart, settings.termEnd, settings.timeZone].join('|');
  return `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}@${UID_DOMAIN}`;
}

function buildEventLines({ timetable, section, meeting, settings, dtstamp, untilUtc, termStart, termEnd }) {
  const weekday = WEEKDAY_NUMBERS[meeting.day];
  if (weekday === undefined) {
    throw new Error('Invalid meeting day in timetable');
  }
  const daysUntilFirst = (weekday - new Date(termStart).getUTCDay() + 7) % 7;
  const firstDay = termStart + daysUntilFirst * DAY_MS;
  if (firstDay > termEnd) {
    return []; // this weekday never happens inside the term
  }

  const start = timeToParts(meeting.startTime);
  const end = timeToParts(meeting.endTime);
  const localStart = firstDay + (start.hours * 60 + start.minutes) * MINUTE_MS;
  const localEnd = firstDay + (end.hours * 60 + end.minutes) * MINUTE_MS;
  const tz = settings.timeZone;

  const descriptionParts = [`Section: ${section.sectionId}`];
  if (timetable.name) {
    descriptionParts.push(`Timetable: ${timetable.name}`);
  }

  return [
    'BEGIN:VEVENT',
    `UID:${buildUid(timetable.id, section, meeting, settings)}`,
    `DTSTAMP:${formatDateTime(dtstamp)}Z`,
    `DTSTART;TZID=${tz}:${formatDateTime(localStart)}`,
    `DTEND;TZID=${tz}:${formatDateTime(localEnd)}`,
    `RRULE:FREQ=WEEKLY;UNTIL=${formatDateTime(untilUtc)}Z`,
    `SUMMARY:${escapeText(`${section.courseCode} ${section.type}`)}`,
    `DESCRIPTION:${escapeText(descriptionParts.join('\n'))}`,
    'END:VEVENT'
  ];
}

// Returns the full .ics file as a string with CRLF line endings.
// settings must come from validateTermSettings().
function buildTimetableCalendar(timetable, settings, now = new Date()) {
  const termStart = parseDate(settings.termStart);
  const termEnd = parseDate(settings.termEnd);
  // RRULE UNTIL must be in UTC when DTSTART has a TZID. The last moment of
  // the last term day (local time) is used, so no class falls outside the term.
  const untilUtc = localToUtc(termEnd + DAY_MS - 1000, settings.timeZone);
  const dtstamp = now.getTime();

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODUCT_ID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...buildTimeZoneLines(settings.timeZone, localToUtc(termStart, settings.timeZone) - DAY_MS, untilUtc)
  ];
  for (const section of timetable.sections) {
    for (const meeting of section.meetings) {
      lines.push(...buildEventLines({ timetable, section, meeting, settings, dtstamp, untilUtc, termStart, termEnd }));
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// A safe ASCII file name such as "Option-A.ics" (falls back to "timetable.ics").
function calendarFileName(timetable) {
  const base = String(timetable.name || '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return `${base || 'timetable'}.ics`;
}

module.exports = {
  DEFAULT_TIME_ZONE,
  validateTermSettings,
  buildTimetableCalendar,
  calendarFileName,
  escapeText,
  foldLine,
  utcOffsetMinutes,
  localToUtc,
  findOffsetChanges
};
