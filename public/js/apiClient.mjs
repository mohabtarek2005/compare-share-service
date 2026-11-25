// Small client for the Compare & Share REST API.
// Every method resolves to { ok: true, data } or { ok: false, status, code, message, details }.
// It never throws, so pages can always show a clear message.

const FRIENDLY_MESSAGES = {
  NOT_SIGNED_IN: 'Please sign in to continue.',
  AUTH_REQUIRED: 'Please sign in to continue.',
  INVALID_TOKEN: 'Your session is invalid or has expired. Please sign in again.',
  AUTH_NOT_CONFIGURED: 'Sign-in is not available on this server yet.',
  TIMETABLE_NOT_FOUND: 'One or more timetables could not be found in your saved timetables.',
  SHARE_NOT_FOUND: 'This share link is unavailable. It may have expired or been revoked.',
  STALE_TIMETABLE: 'One or more timetables are outdated because a course changed. Regenerate them, then try again.',  TIMETABLE_SERVICE_BAD_RESPONSE: 'The Timetable Service sent data that could not be used. Please try again later.',
  TIMETABLE_SERVICE_UNAVAILABLE: 'The Timetable Service is not available right now. Please try again later.',
  SHARE_STORAGE_UNAVAILABLE: 'Share links cannot be loaded right now. Please try again later.',
  SHARE_STORAGE_NOT_CONFIGURED: 'Sharing is not available on this server yet.',
  CALENDAR_NOT_CONFIGURED: 'Calendar download is not available on this server yet.',
  NETWORK_ERROR: 'Cannot reach the server. Check your connection and try again.',
  BAD_RESPONSE: 'The server sent an unexpected response. Please try again later.'
};

const MESSAGES_BY_STATUS = {
  400: 'Some of the information is not valid. Please check it and try again.',
  401: FRIENDLY_MESSAGES.AUTH_REQUIRED,
  404: 'The requested item was not found.',
  409: FRIENDLY_MESSAGES.STALE_TIMETABLE,
  502: FRIENDLY_MESSAGES.TIMETABLE_SERVICE_BAD_RESPONSE,
  503: 'The service is temporarily unavailable. Please try again later.'
};

export function friendlyMessage(status, code) {
  return FRIENDLY_MESSAGES[code] || MESSAGES_BY_STATUS[status] || 'Something went wrong. Please try again.';
}

function failure(status, code, details) {
  const result = { ok: false, status, code, message: friendlyMessage(status, code) };
  if (Array.isArray(details)) {
    // Only the backend's own validation messages are kept, as plain strings.
    result.details = details.map((d) => String((d && d.message) || '')).filter(Boolean);
  }
  return result;
}

function fileNameFrom(contentDisposition) {
  const match = /filename="([^"]+)"/.exec(contentDisposition || '');
  const name = match ? match[1].replace(/[^A-Za-z0-9._-]/g, '') : '';
  return name.endsWith('.ics') ? name : 'timetable.ics';
}

// getToken() returns the in-memory access token (or null).
// refreshSession() (optional) asks Mohamed's /api/auth/refresh for a new one and
// resolves to true on success. When it is given, a request that has no token,
// or that is answered 401 (for example because the 2-hour token expired), gets
// ONE refresh and ONE retry. A second failure is returned to the page.
export function createApiClient({ baseUrl = '', getToken, refreshSession, fetchFn = (...args) => globalThis.fetch(...args) }) {
  async function send(method, path, token, body, expect) {
    const headers = { Authorization: `Bearer ${token}`, Accept: expect === 'blob' ? 'text/calendar' : 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    try {
      return await fetchFn(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin'
      });
    } catch {
      return null;
    }
  }

  async function request(method, path, { body, expect = 'json' } = {}) {
    let token = getToken();
    if (!token && typeof refreshSession === 'function') {
      await refreshSession();
      token = getToken();
    }
    if (!token) {
      return failure(401, 'NOT_SIGNED_IN');
    }

    let response = await send(method, path, token, body, expect);
    if (response === null) {
      return failure(0, 'NETWORK_ERROR');
    }

    if (response.status === 401 && typeof refreshSession === 'function') {
      // If another request already renewed the token meanwhile, reuse it
      // instead of rotating the refresh cookie again.
      const current = getToken();
      const renewed = current && current !== token ? true : await refreshSession();
      const next = getToken();
      if (renewed && next) {
        const retried = await send(method, path, next, body, expect);
        if (retried === null) {
          return failure(0, 'NETWORK_ERROR');
        }
        response = retried;
      }
    }

    if (!response.ok) {
      let error = {};
      try {
        error = (await response.json()).error || {};
      } catch {
        error = {};
      }
      return failure(response.status, typeof error.code === 'string' ? error.code : undefined, error.details);
    }

    try {
      if (expect === 'blob') {
        const blob = await response.blob();
        return { ok: true, data: { blob, fileName: fileNameFrom(response.headers.get('content-disposition')) } };
      }
      return { ok: true, data: await response.json() };
    } catch {
      return failure(response.status, 'BAD_RESPONSE');
    }
  }

  const sharePath = (shareToken) => `/api/shares/${encodeURIComponent(shareToken)}`;

  return {
    request,
    isSignedIn: () => Boolean(getToken()),
    compare: (timetableIds, criterion) => request('POST', '/api/compare', { body: { timetableIds, criterion } }),
    createShare: (timetableId, expiresInDays) => request('POST', '/api/shares', { body: { timetableId, expiresInDays } }),
    listShares: () => request('GET', '/api/shares'),
    getShare: (shareToken) => request('GET', sharePath(shareToken)),
    revokeShare: (shareToken) => request('DELETE', sharePath(shareToken)),
    downloadCalendar: (shareToken) => request('GET', `${sharePath(shareToken)}/calendar.ics`, { expect: 'blob' })
  };
}
