// The ONLY place that knows how to list the student's saved timetables.
// Yehia's list endpoint is not agreed yet (see config.mjs), so this returns
// { ok: false, code: 'NOT_CONFIGURED' } until a path is set. Pages then let the
// student type timetable ids instead. No sample data is ever returned.

export function createTimetableSource({ api, listPath }) {
  async function listSavedTimetables() {
    if (!listPath) {
      return { ok: false, code: 'NOT_CONFIGURED', message: 'The saved timetable list is not connected yet.' };
    }
    const result = await api.request('GET', listPath);
    if (!result.ok) {
      return result;
    }
    const items = Array.isArray(result.data) ? result.data : result.data && result.data.timetables;
    if (!Array.isArray(items)) {
      return { ok: false, code: 'BAD_RESPONSE', message: 'The saved timetable list could not be read.' };
    }
    const timetables = items
      .filter((item) => item && typeof item.id === 'string' && item.id !== '')
      .map((item) => ({ id: item.id, name: typeof item.name === 'string' ? item.name : '' }));
    return { ok: true, data: timetables };
  }

  return { listSavedTimetables };
}
