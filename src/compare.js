const {
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
} = require('./compareAssumptions');

const RANKING_CRITERIA = ['mostFreeDays', 'leastGaps', 'latestStart', 'earliestEnd'];

function timeToMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(totalMinutes) {
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const minutes = String(totalMinutes % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function makeError(code, message, timetableId) {
  const error = { code, message };
  if (timetableId !== undefined) {
    error.timetableId = timetableId;
  }
  return error;
}

// ---------- Metrics ----------
// These expect meetings that have already been validated.

function groupMeetingsByDay(meetings) {
  const byDay = {};
  for (const day of TEACHING_DAYS) {
    byDay[day] = [];
  }
  for (const meeting of meetings) {
    byDay[meeting.day].push(meeting);
  }
  for (const day of TEACHING_DAYS) {
    byDay[day].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  }
  return byDay;
}

function countFreeDays(meetings) {
  const byDay = groupMeetingsByDay(meetings);
  return TEACHING_DAYS.filter((day) => byDay[day].length === 0).length;
}

function totalGapMinutes(meetings) {
  const byDay = groupMeetingsByDay(meetings);
  let total = 0;
  for (const day of TEACHING_DAYS) {
    const classes = byDay[day];
    for (let i = 1; i < classes.length; i++) {
      const gap = timeToMinutes(classes[i].startTime) - timeToMinutes(classes[i - 1].endTime);
      if (gap > 0) {
        total += gap;
      }
    }
  }
  return total;
}

// Returns null for an empty schedule instead of Infinity or NaN.
function earliestStart(meetings) {
  if (meetings.length === 0) {
    return null;
  }
  const earliest = Math.min(...meetings.map((m) => timeToMinutes(m.startTime)));
  return minutesToTime(earliest);
}

function latestEnd(meetings) {
  if (meetings.length === 0) {
    return null;
  }
  const latest = Math.max(...meetings.map((m) => timeToMinutes(m.endTime)));
  return minutesToTime(latest);
}

function calculateMetrics(meetings) {
  return {
    freeDays: countFreeDays(meetings),
    totalGapMinutes: totalGapMinutes(meetings),
    earliestStart: earliestStart(meetings),
    latestEnd: latestEnd(meetings)
  };
}

// ---------- Validation ----------

function validateMeeting(meeting, sectionId, timetableId) {
  const errors = [];
  if (!meeting || typeof meeting !== 'object') {
    return [makeError('MISSING_FIELD', `Section ${sectionId} has an invalid meeting`, timetableId)];
  }
  if (!TEACHING_DAYS.includes(meeting.day)) {
    errors.push(makeError('INVALID_DAY', `Section ${sectionId} has invalid day "${meeting.day}"`, timetableId));
  }
  const startOk = typeof meeting.startTime === 'string' && TIME_PATTERN.test(meeting.startTime);
  const endOk = typeof meeting.endTime === 'string' && TIME_PATTERN.test(meeting.endTime);
  if (!startOk || !endOk) {
    errors.push(makeError('INVALID_TIME', `Section ${sectionId} has a time that is not in HH:MM format`, timetableId));
  } else if (timeToMinutes(meeting.startTime) >= timeToMinutes(meeting.endTime)) {
    errors.push(makeError('INVALID_TIME_RANGE', `Section ${sectionId} starts at or after it ends`, timetableId));
  }
  return errors;
}

// A required text field must be a non-empty string within its length limit.
function checkRequiredText(value, field, maxLength, sectionId, timetableId) {
  if (value === undefined || value === null || value === '') {
    return makeError('MISSING_FIELD', `Section ${sectionId} is missing its ${field}`, timetableId);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return makeError('INVALID_FIELD', `Section ${sectionId} has a ${field} that is not a non-empty string`, timetableId);
  }
  if (value.length > maxLength) {
    return makeError('INVALID_FIELD', `Section ${sectionId} has a ${field} longer than ${maxLength} characters`, timetableId);
  }
  return null;
}

function validateSection(section, timetableId) {
  if (!section || typeof section !== 'object') {
    return [makeError('MISSING_FIELD', 'A section is missing or not an object', timetableId)];
  }
  if (typeof section.sectionId !== 'string' || section.sectionId.trim() === '') {
    return [makeError('MISSING_FIELD', 'A section is missing its sectionId', timetableId)];
  }
  if (section.sectionId.length > MAX_SECTION_ID_LENGTH) {
    return [makeError('INVALID_FIELD', `A sectionId is longer than ${MAX_SECTION_ID_LENGTH} characters`, timetableId)];
  }
  if (!Array.isArray(section.meetings) || section.meetings.length === 0) {
    return [makeError('MISSING_FIELD', `Section ${section.sectionId} has no meetings`, timetableId)];
  }
  const errors = [];
  for (const [field, maxLength] of [['courseCode', MAX_COURSE_CODE_LENGTH], ['type', MAX_SECTION_TYPE_LENGTH]]) {
    const error = checkRequiredText(section[field], field, maxLength, section.sectionId, timetableId);
    if (error) {
      errors.push(error);
    }
  }
  for (const meeting of section.meetings) {
    errors.push(...validateMeeting(meeting, section.sectionId, timetableId));
  }
  return errors;
}

function findOverlaps(meetings, timetableId) {
  const errors = [];
  const byDay = groupMeetingsByDay(meetings);
  for (const day of TEACHING_DAYS) {
    const classes = byDay[day];
    // After sorting by start time, a clash always shows up between neighbours.
    // A class that ends exactly when the next starts is not a clash.
    for (let i = 1; i < classes.length; i++) {
      const previous = classes[i - 1];
      const current = classes[i];
      if (timeToMinutes(current.startTime) < timeToMinutes(previous.endTime)) {
        errors.push(makeError(
          'OVERLAPPING_CLASSES',
          `${previous.sectionId} and ${current.sectionId} overlap on ${day}`,
          timetableId
        ));
      }
    }
  }
  return errors;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// name, stale and missingSectionIds are optional, but when they are present
// they must have the right type. Otherwise "true" or 1 could hide a stale timetable.
function validateOptionalFields(timetable) {
  const id = timetable.id;
  const errors = [];
  if (timetable.name !== undefined && typeof timetable.name !== 'string') {
    errors.push(makeError('INVALID_FIELD', `Timetable ${id} has a name that is not a string`, id));
  } else if (typeof timetable.name === 'string' && timetable.name.length > MAX_TIMETABLE_NAME_LENGTH) {
    errors.push(makeError('INVALID_FIELD', `Timetable ${id} has a name longer than ${MAX_TIMETABLE_NAME_LENGTH} characters`, id));
  }
  if (timetable.stale !== undefined && typeof timetable.stale !== 'boolean') {
    errors.push(makeError('INVALID_FIELD', `Timetable ${id} has a stale value that is not true or false`, id));
  }
  if (timetable.missingSectionIds !== undefined) {
    const list = timetable.missingSectionIds;
    if (!Array.isArray(list) || !list.every(isNonEmptyString)) {
      errors.push(makeError('INVALID_FIELD', `Timetable ${id} has missingSectionIds that is not a list of section ids`, id));
    }
  }
  return errors;
}

function validateTimetable(timetable) {
  if (!timetable || typeof timetable !== 'object') {
    return [makeError('INVALID_TIMETABLE', 'Each timetable must be an object')];
  }
  const id = timetable.id;
  if (typeof id !== 'string' || id.trim() === '') {
    return [makeError('MISSING_FIELD', 'A timetable is missing its id')];
  }
  const fieldErrors = validateOptionalFields(timetable);
  if (fieldErrors.length > 0) {
    return fieldErrors;
  }
  if (isStale(timetable)) {
    return [makeError('STALE_TIMETABLE', `Timetable ${id} is outdated and must be regenerated before comparing`, id)];
  }
  if (!Array.isArray(timetable.sections)) {
    return [makeError('MISSING_FIELD', `Timetable ${id} is missing its sections list`, id)];
  }
  if (timetable.sections.length === 0) {
    return [makeError('EMPTY_TIMETABLE', `Timetable ${id} has no classes`, id)];
  }

  const errors = [];
  for (const section of timetable.sections) {
    errors.push(...validateSection(section, id));
  }
  // Overlaps can only be checked once every meeting has a valid day and time.
  if (errors.length === 0) {
    errors.push(...findOverlaps(getClassMeetings(timetable), id));
  }
  return errors;
}

function validateComparisonRequest(timetables, criterion) {
  if (!Array.isArray(timetables)) {
    return [makeError('INVALID_INPUT', 'Timetables must be provided as a list')];
  }
  const errors = [];
  if (timetables.length < MIN_TIMETABLES || timetables.length > MAX_TIMETABLES) {
    errors.push(makeError(
      'INVALID_TIMETABLE_COUNT',
      `Between ${MIN_TIMETABLES} and ${MAX_TIMETABLES} timetables are required, got ${timetables.length}`
    ));
  }
  if (!RANKING_CRITERIA.includes(criterion)) {
    errors.push(makeError('INVALID_CRITERION', `Ranking criterion must be one of: ${RANKING_CRITERIA.join(', ')}`));
  }

  const seenIds = new Set();
  for (const timetable of timetables) {
    const id = timetable && timetable.id;
    if (typeof id === 'string' && seenIds.has(id)) {
      errors.push(makeError('DUPLICATE_TIMETABLE_ID', `Timetable ${id} was included more than once`, id));
    }
    seenIds.add(id);
  }

  for (const timetable of timetables) {
    errors.push(...validateTimetable(timetable));
  }
  return errors;
}

// ---------- Ranking ----------

// Returns a negative number when a should come before b.
function compareByCriterion(a, b, criterion) {
  switch (criterion) {
    case 'mostFreeDays':
      return b.metrics.freeDays - a.metrics.freeDays;
    case 'leastGaps':
      return a.metrics.totalGapMinutes - b.metrics.totalGapMinutes;
    case 'latestStart':
      return timeToMinutes(b.metrics.earliestStart) - timeToMinutes(a.metrics.earliestStart);
    case 'earliestEnd':
      return timeToMinutes(a.metrics.latestEnd) - timeToMinutes(b.metrics.latestEnd);
  }
}

// Sorts by the chosen criterion. Ties are ordered by timetable id so the result
// is always the same, and tied timetables share the same rank (1, 1, 3, ...).
function rankTimetables(results, criterion) {
  const sorted = [...results].sort((a, b) => {
    const difference = compareByCriterion(a, b, criterion);
    if (difference !== 0) {
      return difference;
    }
    if (a.timetableId < b.timetableId) return -1;
    if (a.timetableId > b.timetableId) return 1;
    return 0;
  });

  const ranked = [];
  for (let i = 0; i < sorted.length; i++) {
    let rank = i + 1;
    if (i > 0 && compareByCriterion(sorted[i - 1], sorted[i], criterion) === 0) {
      rank = ranked[i - 1].rank;
    }
    ranked.push({ ...sorted[i], rank });
  }
  return ranked;
}

// ---------- Main entry point ----------

// Returns { ok: true, criterion, results } or { ok: false, errors }.
function compareTimetables(timetables, criterion) {
  const errors = validateComparisonRequest(timetables, criterion);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const results = timetables.map((timetable) => ({
    timetableId: timetable.id,
    name: timetable.name || null,
    metrics: calculateMetrics(getClassMeetings(timetable))
  }));

  return { ok: true, criterion, results: rankTimetables(results, criterion) };
}

module.exports = {
  RANKING_CRITERIA,
  compareTimetables,
  validateComparisonRequest,
  validateTimetable,
  calculateMetrics,
  countFreeDays,
  totalGapMinutes,
  earliestStart,
  latestEnd,
  rankTimetables
};
