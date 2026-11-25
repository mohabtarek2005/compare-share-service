const {
  timetableUrl,
  normalizeTimetable,
  TIMETABLE_SERVICE_TIMEOUT_MS
} = require('./integrationAssumptions');

// Small client for Yehia's Timetable Service.
// getTimetable() never throws. It returns one of:
//   { ok: true, timetable }   timetable in the internal shape (see normalizeTimetable)
//   { ok: false, reason: 'NOT_FOUND' | 'UNAUTHORIZED' | 'UNAVAILABLE' | 'BAD_RESPONSE' }
// fetchFn can be replaced in tests so no real network calls are made.
function createTimetableClient({ baseUrl, fetchFn = fetch, timeoutMs = TIMETABLE_SERVICE_TIMEOUT_MS }) {
  if (typeof baseUrl !== 'string' || baseUrl === '') {
    throw new Error('Timetable Service URL is not configured');
  }

  async function getTimetable(timetableId, token) {
    let response;
    try {
      response = await fetchFn(timetableUrl(baseUrl, timetableId), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      // Network error or timeout.
      return { ok: false, reason: 'UNAVAILABLE' };
    }

    // 403 is reported the same as 404 so the caller cannot tell whether
    // somebody else's timetable exists.
    if (response.status === 404 || response.status === 403) {
      return { ok: false, reason: 'NOT_FOUND' };
    }
    if (response.status === 401) {
      return { ok: false, reason: 'UNAUTHORIZED' };
    }
    if (response.status === 503) {
      return { ok: false, reason: 'UNAVAILABLE' };
    }
    if (response.status !== 200) {
      return { ok: false, reason: 'BAD_RESPONSE' };
    }

    let body;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: 'BAD_RESPONSE' };
    }

    const result = normalizeTimetable(body);
    // The service must send back the timetable we asked for, in the agreed shape.
    if (!result.ok || result.timetable.id !== timetableId) {
      return { ok: false, reason: 'BAD_RESPONSE' };
    }
    return { ok: true, timetable: result.timetable };
  }

  return { getTimetable };
}

module.exports = { createTimetableClient };
