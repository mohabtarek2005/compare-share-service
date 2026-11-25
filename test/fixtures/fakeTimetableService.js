// TEST-ONLY mocks. Nothing in this file is used by the real server.
//
// testVerifyToken stands in for Mohamed's token verification, and
// createFakeTimetableFetch stands in for Yehia's Timetable Service by
// replacing fetch(). No network calls are made.

const { getSampleTimetables } = require('./sampleTimetables');

const TEST_USERS = {
  'test-token-student-a': { sub: 'student-a', role: 'student' },
  'test-token-student-b': { sub: 'student-b', role: 'student' },
  // Accepted by testVerifyToken but rejected by the fake Timetable Service,
  // like a token that was revoked between the two checks.
  'test-token-revoked': { sub: 'student-a', role: 'student' }
};

async function testVerifyToken(token) {
  return TEST_USERS[token] || null;
}

function buildStore() {
  const { optionA, optionB, optionC } = getSampleTimetables();
  const otherStudents = { ...structuredClone(optionA), id: 'tt-other' };
  const stale = { ...structuredClone(optionB), id: 'tt-stale', stale: true, missingSectionIds: ['MATH201-L2'] };

  const store = {};
  for (const timetable of [optionA, optionB, optionC, stale]) {
    store[timetable.id] = { ...timetable, ownerId: 'student-a' };
  }
  store[otherStudents.id] = { ...otherStudents, ownerId: 'student-b' };
  return store;
}

// The fake keeps its sample timetables in this service's internal shape (easy
// to change in tests) and answers in Yehia's REAL response format (commit
// 01c6397), so every API test also goes through the real adapter.
// Values the tests broke on purpose are passed through as they are.
function toYehiaDay(day) {
  return typeof day === 'string' && day.length > 0 ? day.charAt(0).toUpperCase() + day.slice(1).toLowerCase() : day;
}

function toYehiaSection(section) {
  if (!section || typeof section !== 'object') return section;
  const out = {
    id: section.sectionId,
    courseId: `course-${section.courseCode}`,
    courseCode: section.courseCode,
    courseTitle: section.courseCode,
    sectionCode: section.sectionId,
    type: section.type,
    status: section.status === undefined ? 'ACTIVE' : section.status,
    times: Array.isArray(section.meetings)
      ? section.meetings.map((m) => (m && typeof m === 'object' ? { day: toYehiaDay(m.day), start: m.startTime, end: m.endTime, room: 'R-1' } : m))
      : section.meetings
  };
  return out;
}

function toYehiaTimetable(timetable) {
  if (!timetable || typeof timetable !== 'object' || Array.isArray(timetable)) return timetable;
  const out = { ...timetable };
  if (Array.isArray(timetable.sections)) {
    out.sections = timetable.sections.map(toYehiaSection);
    out.sectionIds = timetable.sections.map((s) => (s && s.sectionId) || null);
  }
  if (out.missingSectionIds === undefined) out.missingSectionIds = [];
  if (out.archivedSectionIds === undefined) out.archivedSectionIds = [];
  return out;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// mode changes how the fake service behaves:
//   'normal'            checks the token and ownership, like the real service should
//   'down'              network failure
//   'serverError'       answers 500
//   'invalidJson'       answers 200 with a body that is not JSON
//   'wrongId'           answers with a different timetable than requested
//   'ignoresOwnership'  a buggy service that returns anyone's timetable
//   'slow'              waits until the request is cancelled (timeout)
// transform (optional) changes a timetable just before it is sent back, to
// simulate a Timetable Service that sends malformed data.
function createFakeTimetableFetch({ mode = 'normal', delayMs = 0, transform } = {}) {
  const store = buildStore();
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;

  async function fakeFetch(url, options) {
    calls.push({ url, authorization: options.headers.Authorization });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return await answer(url, options);
    } finally {
      inFlight--;
    }
  }

  async function answer(url, options) {
    if (mode === 'down') {
      throw new TypeError('fetch failed');
    }
    if (mode === 'slow') {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason));
      });
    }
    if (mode === 'serverError') {
      return jsonResponse(500, { error: { code: 'INTERNAL_ERROR' } });
    }
    if (mode === 'invalidJson') {
      return new Response('<html>not json</html>', { status: 200 });
    }

    const token = (options.headers.Authorization || '').replace('Bearer ', '');
    const user = token === 'test-token-revoked' ? null : TEST_USERS[token];
    if (!user) {
      return jsonResponse(401, { error: { code: 'INVALID_TOKEN' } });
    }

    const id = decodeURIComponent(url.split('/api/timetables/')[1]);
    const timetable = store[id];
    if (!timetable) {
      return jsonResponse(404, { error: { code: 'NOT_FOUND' } });
    }
    if (mode === 'wrongId') {
      return jsonResponse(200, toYehiaTimetable({ ...timetable, id: 'tt-something-else' }));
    }
    if (mode !== 'ignoresOwnership' && timetable.ownerId !== user.sub) {
      return jsonResponse(403, { error: { code: 'FORBIDDEN' } });
    }
    const body = transform ? transform(structuredClone(timetable)) : timetable;
    return jsonResponse(200, toYehiaTimetable(body));
  }

  return {
    fetchFn: fakeFetch,
    calls,
    store,
    getMaxInFlight: () => maxInFlight
  };
}

module.exports = { TEST_USERS, testVerifyToken, createFakeTimetableFetch };
