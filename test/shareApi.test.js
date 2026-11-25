const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { createApp } = require('../src/app');
const { createTimetableClient } = require('../src/timetableClient');
const { testVerifyToken, createFakeTimetableFetch } = require('./fixtures/fakeTimetableService');
const { createFakeShareStore } = require('./fixtures/fakeShareStore');

const TOKEN_A = 'test-token-student-a';
const TOKEN_B = 'test-token-student-b';
const FAKE_SERVICE_URL = 'http://timetable-service.test';
const START_TIME = new Date('2026-11-23T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// Test-only academic term (Sunday 13 Sep to Thursday 31 Dec 2026, with the
// Cairo daylight-saving change on 30 Oct inside it).
const TEST_TERM = { termStart: '2026-09-13', termEnd: '2026-12-31', timeZone: 'Africa/Cairo' };

// Starts the API with test-only mocks and a clock the tests can move forward.
async function startApi(t, options = {}) {
  const fakeService = options.fakeService || createFakeTimetableFetch();
  const shareStore = 'shareStore' in options ? options.shareStore : createFakeShareStore();
  const clock = { time: START_TIME.getTime() };
  const logLines = [];
  const app = createApp({
    verifyToken: testVerifyToken,
    timetableClient: createTimetableClient({ baseUrl: FAKE_SERVICE_URL, fetchFn: fakeService.fetchFn }),
    shareStore,
    calendarSettings: TEST_TERM,
    now: () => new Date(clock.time),
    logError: (line) => logLines.push(line),
    ...options.appOptions
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    fakeService,
    shareStore,
    logLines,
    advanceTime: (ms) => (clock.time += ms)
  };
}

async function callApi(baseUrl, method, path, { token = TOKEN_A, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null };
}

function createShare(api, body = { timetableId: 'tt-a', expiresInDays: 7 }, token = TOKEN_A) {
  return callApi(api.baseUrl, 'POST', '/api/shares', { token, body });
}

function detailCodes(body) {
  return body.error.details.map((detail) => detail.code);
}

describe('POST /api/shares - create a share link', () => {
  test('creates a share link and stores a snapshot', async (t) => {
    const api = await startApi(t);
    const res = await createShare(api);

    assert.equal(res.status, 201);
    assert.match(res.body.token, SHARE_TOKEN_PATTERN);
    assert.deepEqual(res.body, {
      token: res.body.token,
      timetableId: 'tt-a',
      timetableName: 'Option A',
      createdAt: '2026-11-23T10:00:00.000Z',
      expiresAt: '2026-11-30T10:00:00.000Z',
      sharePath: `/api/shares/${res.body.token}`
    });

    const stored = api.shareStore.items.get(res.body.token);
    assert.equal(stored.ownerId, 'student-a');
    assert.equal(stored.timetableId, 'tt-a');
    assert.equal(stored.expiresAtEpoch, Date.parse('2026-11-30T10:00:00.000Z') / 1000);
    assert.equal(stored.revokedAt, undefined);
    assert.equal(stored.snapshot.sections.length, 4);
    assert.equal('ownerId' in stored.snapshot, false);
  });

  test('forwards the user\'s token to the Timetable Service', async (t) => {
    const api = await startApi(t);
    await createShare(api);
    assert.deepEqual(api.fakeService.calls, [
      { url: `${FAKE_SERVICE_URL}/api/timetables/tt-a`, authorization: `Bearer ${TOKEN_A}` }
    ]);
  });

  test('every link gets a different random token', async (t) => {
    const api = await startApi(t);
    const tokens = new Set();
    for (let i = 0; i < 20; i++) {
      tokens.add((await createShare(api)).body.token);
    }
    assert.equal(tokens.size, 20);
  });

  test('ignores a snapshot or owner id sent by the browser', async (t) => {
    const api = await startApi(t);
    const res = await createShare(api, {
      timetableId: 'tt-a',
      expiresInDays: 7,
      ownerId: 'student-b',
      snapshot: { id: 'tt-a', sections: [] }
    });
    assert.equal(res.status, 201);
    const stored = api.shareStore.items.get(res.body.token);
    assert.equal(stored.ownerId, 'student-a');
    assert.equal(stored.snapshot.sections.length, 4);
  });

  test('accepts the boundary expiry values 1 and 30 days', async (t) => {
    const api = await startApi(t);
    const oneDay = await createShare(api, { timetableId: 'tt-a', expiresInDays: 1 });
    const thirtyDays = await createShare(api, { timetableId: 'tt-a', expiresInDays: 30 });
    assert.equal(oneDay.body.expiresAt, '2026-11-24T10:00:00.000Z');
    assert.equal(thirtyDays.body.expiresAt, '2026-12-23T10:00:00.000Z');
  });

  test('rejects an invalid expiry period', async (t) => {
    const api = await startApi(t);
    for (const expiresInDays of [0, 31, -1, 1.5, '7', null, undefined, 999999]) {
      const res = await createShare(api, { timetableId: 'tt-a', expiresInDays });
      assert.equal(res.status, 400, `expiresInDays ${JSON.stringify(expiresInDays)} should be rejected`);
      assert.deepEqual(detailCodes(res.body), ['INVALID_EXPIRY']);
    }
    assert.equal(api.fakeService.calls.length, 0);
    assert.equal(api.shareStore.items.size, 0);
  });

  test('rejects an invalid timetable id before calling the Timetable Service', async (t) => {
    const api = await startApi(t);
    for (const timetableId of ['.', '..', '', ' tt-a', 'tt\na', 5, null, undefined]) {
      const res = await createShare(api, { timetableId, expiresInDays: 7 });
      assert.equal(res.status, 400);
      assert.deepEqual(detailCodes(res.body), ['INVALID_TIMETABLE_ID']);
    }
    assert.equal(api.fakeService.calls.length, 0);
  });

  test('rejects a body that is not an object', async (t) => {
    const api = await startApi(t);
    const res = await callApi(api.baseUrl, 'POST', '/api/shares', { body: ['tt-a'] });
    assert.equal(res.status, 400);
    assert.deepEqual(detailCodes(res.body), ['INVALID_INPUT']);
  });

  test('returns 404 when sharing another student\'s timetable', async (t) => {
    const api = await startApi(t);
    const res = await createShare(api, { timetableId: 'tt-other', expiresInDays: 7 });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'TIMETABLE_NOT_FOUND');
    assert.equal(api.shareStore.items.size, 0);
  });

  test('returns 404 when the Timetable Service wrongly returns another student\'s timetable', async (t) => {
    const api = await startApi(t, { fakeService: createFakeTimetableFetch({ mode: 'ignoresOwnership' }) });
    const res = await createShare(api, { timetableId: 'tt-other', expiresInDays: 7 });
    assert.equal(res.status, 404);
    assert.equal(api.shareStore.items.size, 0);
  });

  test('returns 404 when the timetable does not exist', async (t) => {
    const api = await startApi(t);
    const res = await createShare(api, { timetableId: 'tt-missing', expiresInDays: 7 });
    assert.equal(res.status, 404);
  });

  test('returns 409 when sharing a stale timetable', async (t) => {
    const api = await startApi(t);
    const res = await createShare(api, { timetableId: 'tt-stale', expiresInDays: 7 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'STALE_TIMETABLE');
    assert.equal(api.shareStore.items.size, 0);
  });

  test('returns 502 when the timetable data is malformed or has no owner', async (t) => {
    const changes = [
      (timetable) => delete timetable.ownerId,
      (timetable) => (timetable.sections = []),
      (timetable) => (timetable.sections[0].meetings[0].day = 'FRI')
    ];
    for (const change of changes) {
      const fakeService = createFakeTimetableFetch({ transform: (timetable) => (change(timetable), timetable) });
      const api = await startApi(t, { fakeService });
      const res = await createShare(api);
      assert.equal(res.status, 502);
      assert.equal(api.shareStore.items.size, 0);
    }
  });

  test('returns 503 when the Timetable Service is down', async (t) => {
    const api = await startApi(t, { fakeService: createFakeTimetableFetch({ mode: 'down' }) });
    const res = await createShare(api);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'TIMETABLE_SERVICE_UNAVAILABLE');
  });

  test('tries a new token if the generated one already exists', async (t) => {
    const shareStore = createFakeShareStore();
    const realCreate = shareStore.createShare;
    let attempts = 0;
    shareStore.createShare = async (record) => {
      attempts++;
      return attempts === 1 ? false : realCreate(record);
    };
    const api = await startApi(t, { shareStore });
    const res = await createShare(api);
    assert.equal(res.status, 201);
    assert.equal(attempts, 2);
  });

  test('gives up with a 500 if no unique token can be stored', async (t) => {
    const shareStore = createFakeShareStore();
    shareStore.createShare = async () => false;
    const api = await startApi(t, { shareStore });
    const res = await createShare(api);
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, 'INTERNAL_ERROR');
  });
});

describe('GET /api/shares/:token - view a shared timetable', () => {
  test('any logged-in user with the link can view the snapshot', async (t) => {
    const api = await startApi(t);
    const { token } = (await createShare(api)).body;

    const res = await callApi(api.baseUrl, 'GET', `/api/shares/${token}`, { token: TOKEN_B });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ['createdAt', 'expiresAt', 'timetable']);
    assert.equal(res.body.timetable.id, 'tt-a');
    assert.equal(res.body.timetable.name, 'Option A');
    assert.deepEqual(res.body.timetable.sections[0], {
      sectionId: 'CS101-L1',
      courseCode: 'CS101',
      type: 'LECTURE',
      meetings: [
        { day: 'SUN', startTime: '09:00', endTime: '10:30' },
        { day: 'TUE', startTime: '09:00', endTime: '10:30' }
      ]
    });
    // No owner information or login tokens in the response.
    assert.doesNotMatch(res.text, /student-a|ownerId|test-token/);
  });

  test('the snapshot does not change when the saved timetable changes later', async (t) => {
    const api = await startApi(t);
    const { token } = (await createShare(api)).body;
    api.fakeService.store['tt-a'].sections = [];
    api.fakeService.store['tt-a'].name = 'Renamed';

    const res = await callApi(api.baseUrl, 'GET', `/api/shares/${token}`, { token: TOKEN_B });
    assert.equal(res.body.timetable.name, 'Option A');
    assert.equal(res.body.timetable.sections.length, 4);
  });

  test('works until the expiry time and is refused from then on', async (t) => {
    const api = await startApi(t);
    const { token } = (await createShare(api, { timetableId: 'tt-a', expiresInDays: 7 })).body;

    api.advanceTime(7 * DAY_MS - 1);
    assert.equal((await callApi(api.baseUrl, 'GET', `/api/shares/${token}`)).status, 200);

    api.advanceTime(1);
    const expired = await callApi(api.baseUrl, 'GET', `/api/shares/${token}`);
    assert.equal(expired.status, 404);
    assert.equal(expired.body.error.code, 'SHARE_NOT_FOUND');
  });

  test('a revoked link cannot be opened', async (t) => {
    const api = await startApi(t);
    const { token } = (await createShare(api)).body;
    await callApi(api.baseUrl, 'DELETE', `/api/shares/${token}`);

    const res = await callApi(api.baseUrl, 'GET', `/api/shares/${token}`, { token: TOKEN_B });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'SHARE_NOT_FOUND');
  });

  test('unknown and badly formed share tokens return 404', async (t) => {
    const api = await startApi(t);
    const badTokens = ['abc', 'A'.repeat(42) + '!', 'A'.repeat(44), 'A'.repeat(43)];
    for (const shareToken of badTokens) {
      const res = await callApi(api.baseUrl, 'GET', `/api/shares/${encodeURIComponent(shareToken)}`);
      assert.equal(res.status, 404, `token ${shareToken} should not be found`);
      assert.equal(res.body.error.code, 'SHARE_NOT_FOUND');
    }
  });
});

describe('GET /api/shares - list my share links', () => {
  test('lists only the current user\'s active links, newest first', async (t) => {
    const api = await startApi(t);
    const longLink = (await createShare(api, { timetableId: 'tt-a', expiresInDays: 7 })).body;
    api.advanceTime(1000);
    const shortLink = (await createShare(api, { timetableId: 'tt-b', expiresInDays: 1 })).body;
    api.advanceTime(1000);
    const revokedLink = (await createShare(api, { timetableId: 'tt-c', expiresInDays: 30 })).body;
    api.advanceTime(1000);
    const newestLink = (await createShare(api, { timetableId: 'tt-c', expiresInDays: 30 })).body;
    await callApi(api.baseUrl, 'DELETE', `/api/shares/${revokedLink.token}`);
    await createShare(api, { timetableId: 'tt-other', expiresInDays: 7 }, TOKEN_B);

    let res = await callApi(api.baseUrl, 'GET', '/api/shares');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.shares.map((s) => s.token), [newestLink.token, shortLink.token, longLink.token]);

    api.advanceTime(2 * DAY_MS); // the 1-day link has now expired
    res = await callApi(api.baseUrl, 'GET', '/api/shares');
    assert.deepEqual(res.body.shares.map((s) => s.token), [newestLink.token, longLink.token]);
    assert.deepEqual(res.body.shares[1], {
      token: longLink.token,
      timetableId: 'tt-a',
      timetableName: 'Option A',
      createdAt: longLink.createdAt,
      expiresAt: longLink.expiresAt,
      sharePath: `/api/shares/${longLink.token}`
    });
  });

  test('another user only sees their own links', async (t) => {
    const api = await startApi(t);
    await createShare(api);
    const res = await callApi(api.baseUrl, 'GET', '/api/shares', { token: TOKEN_B });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { shares: [] });
  });

  test('a user id in the query string is ignored', async (t) => {
    const api = await startApi(t);
    await createShare(api);
    const res = await callApi(api.baseUrl, 'GET', '/api/shares?ownerId=student-a', { token: TOKEN_B });
    assert.deepEqual(res.body, { shares: [] });
  });
});

describe('DELETE /api/shares/:token - revoke a share link', () => {
  test('the owner can revoke their link, and only once', async (t) => {
    const api = await startApi(t);
    const { token } = (await createShare(api)).body;
    api.advanceTime(60 * 1000);

    const res = await callApi(api.baseUrl, 'DELETE', `/api/shares/${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { token, revokedAt: '2026-11-23T10:01:00.000Z' });
    assert.equal(api.shareStore.items.get(token).revokedAt, '2026-11-23T10:01:00.000Z');

    const again = await callApi(api.baseUrl, 'DELETE', `/api/shares/${token}`);
    assert.equal(again.status, 404);
    assert.equal(again.body.error.code, 'SHARE_NOT_FOUND');
  });

  test('another user cannot revoke the link', async (t) => {
    const api = await startApi(t);
    const { token } = (await createShare(api)).body;

    const res = await callApi(api.baseUrl, 'DELETE', `/api/shares/${token}`, { token: TOKEN_B });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'SHARE_NOT_FOUND');
    assert.equal(api.shareStore.items.get(token).revokedAt, undefined);
    assert.equal((await callApi(api.baseUrl, 'GET', `/api/shares/${token}`, { token: TOKEN_B })).status, 200);
  });

  test('missing, expired and badly formed links return the same 404', async (t) => {
    const api = await startApi(t);
    const { token } = (await createShare(api, { timetableId: 'tt-a', expiresInDays: 1 })).body;
    api.advanceTime(DAY_MS);

    for (const shareToken of [token, 'A'.repeat(43), 'not-a-token']) {
      const res = await callApi(api.baseUrl, 'DELETE', `/api/shares/${shareToken}`);
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, {
        error: { code: 'SHARE_NOT_FOUND', message: 'This share link does not exist, has expired or was revoked' }
      });
    }
  });
});

describe('Share endpoints - authentication', () => {
  const endpoints = [
    ['POST', '/api/shares', { timetableId: 'tt-a', expiresInDays: 7 }],
    ['GET', '/api/shares'],
    ['GET', `/api/shares/${'A'.repeat(43)}`],
    ['DELETE', `/api/shares/${'A'.repeat(43)}`]
  ];

  test('every share endpoint requires a login token', async (t) => {
    const api = await startApi(t);
    for (const [method, path, body] of endpoints) {
      const res = await callApi(api.baseUrl, method, path, { token: null, body });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.body.error.code, 'AUTH_REQUIRED');
    }
    assert.equal(api.fakeService.calls.length, 0);
  });

  test('every share endpoint rejects an invalid login token', async (t) => {
    const api = await startApi(t);
    for (const [method, path, body] of endpoints) {
      const res = await callApi(api.baseUrl, method, path, { token: 'made-up-token', body });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.body.error.code, 'INVALID_TOKEN');
    }
  });

  test('every share endpoint fails closed when token verification is not configured', async (t) => {
    const api = await startApi(t, { appOptions: { verifyToken: undefined } });
    for (const [method, path, body] of endpoints) {
      const res = await callApi(api.baseUrl, method, path, { body });
      assert.equal(res.status, 503, `${method} ${path}`);
      assert.equal(res.body.error.code, 'AUTH_NOT_CONFIGURED');
    }
  });
});

describe('Share endpoints - storage problems and unexpected errors', () => {
  test('returns 503 on every endpoint when the database fails', async (t) => {
    const api = await startApi(t);
    const { token } = (await createShare(api)).body;
    api.shareStore.setFailing(true);

    const requests = [
      ['POST', '/api/shares', { timetableId: 'tt-a', expiresInDays: 7 }],
      ['GET', '/api/shares'],
      ['GET', `/api/shares/${token}`],
      ['DELETE', `/api/shares/${token}`]
    ];
    for (const [method, path, body] of requests) {
      const res = await callApi(api.baseUrl, method, path, { body });
      assert.equal(res.status, 503, `${method} ${path}`);
      assert.deepEqual(res.body, {
        error: { code: 'SHARE_STORAGE_UNAVAILABLE', message: 'Share storage is not available' }
      });
    }
    // Logs name the route pattern, never the real share token.
    assert.equal(api.logLines.length, 4);
    for (const line of api.logLines) {
      assert.doesNotMatch(line, new RegExp(token));
      assert.doesNotMatch(line, /simulated database outage/);
    }
  });

  test('refuses share requests when no database is configured', async (t) => {
    const api = await startApi(t, { shareStore: undefined });
    const res = await createShare(api);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'SHARE_STORAGE_NOT_CONFIGURED');

    const noLogin = await callApi(api.baseUrl, 'GET', '/api/shares', { token: null });
    assert.equal(noLogin.status, 401);
  });

  test('unexpected errors return a generic 500 without leaking details', async (t) => {
    const shareStore = createFakeShareStore();
    shareStore.getShare = async () => {
      throw new Error('connection string password=hunter2');
    };
    const api = await startApi(t, { shareStore });
    const shareToken = 'B'.repeat(43);
    const res = await callApi(api.baseUrl, 'GET', `/api/shares/${shareToken}`);

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
    assert.equal(api.logLines.length, 1);
    assert.equal(JSON.parse(api.logLines[0]).route, '/api/shares/:token');
    assert.doesNotMatch(api.logLines[0], /hunter2|BBBB|test-token/);
  });

  test('the Compare endpoint still works next to the share endpoints', async (t) => {
    const api = await startApi(t);
    const res = await callApi(api.baseUrl, 'POST', '/api/compare', {
      body: { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' }
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.results.map((r) => r.timetableId), ['tt-b', 'tt-a']);
  });
});

describe('POST /api/shares - snapshot validation and size limit', () => {
  const { recordSizeBytes, MAX_RECORD_BYTES } = require('../src/shareRoutes');
  const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU'];
  const ARABIC_LETTER = 'م'; // 2 bytes in UTF-8

  function changeTimetableA(change) {
    return createFakeTimetableFetch({
      transform: (timetable) => {
        if (timetable.id === 'tt-a') change(timetable);
        return timetable;
      }
    });
  }

  function minutesToTime(minutes) {
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  // Many valid, non-overlapping one-minute classes with long text fields.
  function buildLargeSections(count, letter) {
    const sections = [];
    for (let i = 0; i < count; i++) {
      const minute = Math.floor(i / DAYS.length);
      sections.push({
        sectionId: letter.repeat(95) + String(i).padStart(5, '0'),
        courseCode: letter.repeat(50),
        type: letter.repeat(50),
        meetings: [{ day: DAYS[i % DAYS.length], startTime: minutesToTime(minute), endTime: minutesToTime(minute + 1) }]
      });
    }
    return sections;
  }

  test('rejects an invalid courseCode or section type with 502 and stores nothing', async (t) => {
    const badValues = [42, null, '', '   ', [], {}, 'x'.repeat(51)];
    for (const field of ['courseCode', 'type']) {
      for (const badValue of badValues) {
        const api = await startApi(t, { fakeService: changeTimetableA((tt) => (tt.sections[0][field] = badValue)) });
        const res = await createShare(api);
        assert.equal(res.status, 502, `${field} ${JSON.stringify(badValue)} should be rejected`);
        assert.equal(res.body.error.code, 'TIMETABLE_SERVICE_BAD_RESPONSE');
        assert.equal(api.shareStore.items.size, 0);
      }
    }
  });

  test('rejects other empty required fields and over-long names without storing', async (t) => {
    const changes = [
      (tt) => (tt.sections[0].sectionId = ''),
      (tt) => delete tt.sections[0].courseCode,
      (tt) => delete tt.sections[0].type,
      (tt) => (tt.sections[0].sectionId = 'x'.repeat(101)),
      (tt) => (tt.name = 'n'.repeat(201))
    ];
    for (const change of changes) {
      const api = await startApi(t, { fakeService: changeTimetableA(change) });
      const res = await createShare(api);
      assert.equal(res.status, 502);
      assert.equal(api.shareStore.items.size, 0);
    }
  });

  test('accepts valid data at the length limits and an optional missing name', async (t) => {
    const fakeService = changeTimetableA((tt) => {
      tt.name = 'n'.repeat(200);
      tt.sections[0].sectionId = 's'.repeat(100);
      tt.sections[0].courseCode = 'c'.repeat(50);
      tt.sections[0].type = 't'.repeat(50);
    });
    const api = await startApi(t, { fakeService });
    const res = await createShare(api);
    assert.equal(res.status, 201);
    assert.equal(api.shareStore.items.get(res.body.token).snapshot.sections[0].courseCode, 'c'.repeat(50));

    const noName = await startApi(t, { fakeService: changeTimetableA((tt) => delete tt.name) });
    const noNameRes = await createShare(noName);
    assert.equal(noNameRes.status, 201);
    assert.equal(noNameRes.body.timetableName, null);
  });

  test('accepts a large timetable that is still under the size limit', async (t) => {
    const api = await startApi(t, { fakeService: changeTimetableA((tt) => (tt.sections = buildLargeSections(600, 'x'))) });
    const res = await createShare(api);
    assert.equal(res.status, 201);
    assert.ok(recordSizeBytes(api.shareStore.items.get(res.body.token)) <= MAX_RECORD_BYTES);
  });

  test('rejects an oversized snapshot with a generic 502 and stores nothing', async (t) => {
    const api = await startApi(t, { fakeService: changeTimetableA((tt) => (tt.sections = buildLargeSections(1200, 'x'))) });
    const res = await createShare(api);
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, {
      error: { code: 'TIMETABLE_SERVICE_BAD_RESPONSE', message: 'The Timetable Service sent an invalid response' }
    });
    assert.equal(api.shareStore.items.size, 0);
  });

  test('measures size in UTF-8 bytes, not string length', async (t) => {
    const sections = buildLargeSections(700, ARABIC_LETTER);
    const json = JSON.stringify(sections);
    assert.ok(json.length < MAX_RECORD_BYTES, 'string length alone would look small enough');
    assert.ok(Buffer.byteLength(json, 'utf8') > MAX_RECORD_BYTES, 'but the UTF-8 size is too big');

    const api = await startApi(t, { fakeService: changeTimetableA((tt) => (tt.sections = sections)) });
    const res = await createShare(api);
    assert.equal(res.status, 502);
    assert.equal(api.shareStore.items.size, 0);
  });

  test('recordSizeBytes counts multi-byte characters correctly', () => {
    const ascii = recordSizeBytes({ name: 'ab' });
    const arabic = recordSizeBytes({ name: ARABIC_LETTER.repeat(2) });
    assert.equal(arabic - ascii, 2);
  });
});

describe('GET /api/shares/:token/calendar.ics - calendar download', () => {
  async function downloadCalendar(api, shareToken, userToken = TOKEN_A) {
    const headers = userToken ? { Authorization: `Bearer ${userToken}` } : {};
    const response = await fetch(`${api.baseUrl}/api/shares/${shareToken}/calendar.ics`, { headers });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text };
  }

  function countLines(ics, line) {
    return ics.split('\r\n').filter((l) => l === line).length;
  }

  test('any logged-in user with the link can download a valid .ics file', async (t) => {
    const api = await startApi(t);
    const { token } = (await createShare(api)).body;
    const res = await downloadCalendar(api, token, TOKEN_B);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/calendar; charset=utf-8');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="Option-A.ics"');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(res.text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
    assert.ok(res.text.endsWith('END:VCALENDAR\r\n'));
    assert.equal(countLines(res.text, 'BEGIN:VEVENT'), 6); // Option A has 6 weekly meetings
    assert.match(res.text, /\r\nDTSTART;TZID=Africa\/Cairo:20260913T090000\r\n/);
    assert.match(res.text, /\r\nRRULE:FREQ=WEEKLY;UNTIL=20261231T215959Z\r\n/);
  });

  test('is built from the stored snapshot, not the live timetable', async (t) => {
    const api = await startApi(t);
    const { token } = (await createShare(api)).body;
    api.fakeService.store['tt-a'].sections = api.fakeService.store['tt-a'].sections.slice(0, 1);

    const res = await downloadCalendar(api, token);
    assert.equal(countLines(res.text, 'BEGIN:VEVENT'), 6);
  });

  test('contains no share token, owner id or login token', async (t) => {
    const api = await startApi(t);
    const { token } = (await createShare(api)).body;
    const res = await downloadCalendar(api, token, TOKEN_B);
    assert.equal(res.text.includes(token), false);
    assert.doesNotMatch(res.text, /student-a|student-b|ownerId|test-token/);
  });

  test('requires a valid login token', async (t) => {
    const api = await startApi(t);
    const { token } = (await createShare(api)).body;
    const noLogin = await downloadCalendar(api, token, null);
    assert.equal(noLogin.status, 401);
    assert.equal(JSON.parse(noLogin.text).error.code, 'AUTH_REQUIRED');

    const badLogin = await downloadCalendar(api, token, 'made-up-token');
    assert.equal(badLogin.status, 401);
    assert.equal(JSON.parse(badLogin.text).error.code, 'INVALID_TOKEN');
  });

  test('badly formed and unknown share tokens return 404', async (t) => {
    const api = await startApi(t);
    for (const shareToken of ['abc', 'A'.repeat(44), 'A'.repeat(43)]) {
      const res = await downloadCalendar(api, shareToken);
      assert.equal(res.status, 404);
      assert.equal(JSON.parse(res.text).error.code, 'SHARE_NOT_FOUND');
    }
  });

  test('expired and revoked links cannot be downloaded', async (t) => {
    const api = await startApi(t);
    const shortLink = (await createShare(api, { timetableId: 'tt-a', expiresInDays: 1 })).body;
    const revokedLink = (await createShare(api)).body;
    await callApi(api.baseUrl, 'DELETE', `/api/shares/${revokedLink.token}`);

    assert.equal((await downloadCalendar(api, revokedLink.token)).status, 404);
    assert.equal((await downloadCalendar(api, shortLink.token)).status, 200);
    api.advanceTime(DAY_MS);
    const expired = await downloadCalendar(api, shortLink.token);
    assert.equal(expired.status, 404);
    assert.equal(JSON.parse(expired.text).error.code, 'SHARE_NOT_FOUND');
  });

  test('returns 503 when the term settings are missing or invalid', async (t) => {
    const settingsList = [
      undefined,
      { termStart: '2026-09-13' },
      { termStart: '2026-12-31', termEnd: '2026-09-13', timeZone: 'Africa/Cairo' },
      { termStart: '2026-09-13', termEnd: '2026-12-31', timeZone: 'Mars/Olympus' }
    ];
    for (const calendarSettings of settingsList) {
      const api = await startApi(t, { appOptions: { calendarSettings } });
      const { token } = (await createShare(api)).body;
      const res = await downloadCalendar(api, token);
      assert.equal(res.status, 503);
      assert.deepEqual(JSON.parse(res.text), {
        error: { code: 'CALENDAR_NOT_CONFIGURED', message: 'Calendar export is not available' }
      });
    }
  });

  test('a database failure returns 503 without logging the share token', async (t) => {
    const api = await startApi(t);
    const { token } = (await createShare(api)).body;
    api.shareStore.setFailing(true);
    const res = await downloadCalendar(api, token);
    assert.equal(res.status, 503);
    assert.equal(JSON.parse(res.text).error.code, 'SHARE_STORAGE_UNAVAILABLE');
    assert.equal(api.logLines.length, 1);
    assert.equal(JSON.parse(api.logLines[0]).route, '/api/shares/:token/calendar.ics');
    assert.equal(api.logLines[0].includes(token), false);
  });

  test('a corrupted stored snapshot gives a generic 500', async (t) => {
    const api = await startApi(t);
    const { token } = (await createShare(api)).body;
    api.shareStore.items.get(token).snapshot.sections[0].meetings[0].day = 'XYZ';
    const res = await downloadCalendar(api, token);
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.text), { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  });

  test('an Arabic timetable name gives a safe ASCII file name', async (t) => {
    const fakeService = createFakeTimetableFetch({
      transform: (tt) => ((tt.name = 'جدولي'), tt)
    });
    const api = await startApi(t, { fakeService });
    const { token } = (await createShare(api)).body;
    const res = await downloadCalendar(api, token);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="timetable.ics"');
    assert.match(res.text.replace(/\r\n /g, ''), /Timetable: جدولي/);
  });
});
