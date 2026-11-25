const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { createApp } = require('../src/app');
const { createTimetableClient } = require('../src/timetableClient');
const { testVerifyToken, createFakeTimetableFetch } = require('./fixtures/fakeTimetableService');

const TOKEN_A = 'test-token-student-a';
const FAKE_SERVICE_URL = 'http://timetable-service.test';

// Starts the Compare API on a free local port, using test-only mocks.
async function startApi(t, { fakeService = createFakeTimetableFetch(), appOptions = {}, timeoutMs } = {}) {
  const timetableClient = createTimetableClient({
    baseUrl: FAKE_SERVICE_URL,
    fetchFn: fakeService.fetchFn,
    timeoutMs
  });
  const app = createApp({
    verifyToken: testVerifyToken,
    timetableClient,
    logError: () => {},
    ...appOptions
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, fakeService };
}

async function postCompare(baseUrl, body, { token = TOKEN_A, authorization } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authorization !== undefined) {
    headers.Authorization = authorization;
  } else if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${baseUrl}/api/compare`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: JSON.parse(text) };
}

function detailCodes(body) {
  return body.error.details.map((detail) => detail.code);
}

describe('POST /api/compare - successful comparisons', () => {
  test('returns 200 with the ranked comparison', async (t) => {
    const { baseUrl } = await startApi(t);
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b', 'tt-c'], criterion: 'leastGaps' });

    assert.equal(res.status, 200);
    assert.equal(res.body.criterion, 'leastGaps');
    assert.deepEqual(
      res.body.results.map((r) => `${r.rank}:${r.timetableId}`),
      ['1:tt-b', '2:tt-a', '3:tt-c']
    );
  });

  test('response has the expected structure', async (t) => {
    const { baseUrl } = await startApi(t);
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion: 'mostFreeDays' });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(Object.keys(res.body).sort(), ['criterion', 'results']);
    assert.deepEqual(res.body.results[0], {
      timetableId: 'tt-b',
      name: 'Option B',
      metrics: { freeDays: 3, totalGapMinutes: 0, earliestStart: '09:00', latestEnd: '13:30' },
      rank: 1
    });
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  test('forwards the user\'s token to the Timetable Service for every timetable', async (t) => {
    const { baseUrl, fakeService } = await startApi(t);
    await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-c'], criterion: 'earliestEnd' });

    assert.deepEqual(fakeService.calls, [
      { url: `${FAKE_SERVICE_URL}/api/timetables/tt-a`, authorization: `Bearer ${TOKEN_A}` },
      { url: `${FAKE_SERVICE_URL}/api/timetables/tt-c`, authorization: `Bearer ${TOKEN_A}` }
    ]);
  });

  test('fetches the timetables in parallel', async (t) => {
    const fakeService = createFakeTimetableFetch({ delayMs: 30 });
    const { baseUrl } = await startApi(t, { fakeService });
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b', 'tt-c'], criterion: 'leastGaps' });

    assert.equal(res.status, 200);
    assert.equal(fakeService.getMaxInFlight(), 3);
  });

  test('ignores timetable details sent by the browser', async (t) => {
    const { baseUrl } = await startApi(t);
    const fakeTimetable = { id: 'tt-a', sections: [], ownerId: 'student-a' };
    const res = await postCompare(baseUrl, {
      timetableIds: ['tt-a', 'tt-b'],
      criterion: 'leastGaps',
      timetables: [fakeTimetable]
    });

    assert.equal(res.status, 200);
    const a = res.body.results.find((r) => r.timetableId === 'tt-a');
    assert.equal(a.metrics.totalGapMinutes, 120);
  });
});

describe('POST /api/compare - invalid requests (400)', () => {
  test('rejects fewer than 2 or more than 5 timetable ids', async (t) => {
    const { baseUrl, fakeService } = await startApi(t);
    for (const ids of [[], ['tt-a'], ['t1', 't2', 't3', 't4', 't5', 't6']]) {
      const res = await postCompare(baseUrl, { timetableIds: ids, criterion: 'leastGaps' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_REQUEST');
      assert.deepEqual(detailCodes(res.body), ['INVALID_TIMETABLE_COUNT']);
    }
    assert.equal(fakeService.calls.length, 0);
  });

  test('rejects duplicate timetable ids', async (t) => {
    const { baseUrl, fakeService } = await startApi(t);
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-a'], criterion: 'leastGaps' });
    assert.equal(res.status, 400);
    assert.deepEqual(detailCodes(res.body), ['DUPLICATE_TIMETABLE_ID']);
    assert.equal(fakeService.calls.length, 0);
  });

  test('rejects an invalid or missing criterion', async (t) => {
    const { baseUrl } = await startApi(t);
    for (const criterion of ['cheapest', '', 5, undefined]) {
      const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion });
      assert.equal(res.status, 400);
      assert.deepEqual(detailCodes(res.body), ['INVALID_CRITERION']);
    }
  });

  test('rejects timetable ids that are not non-empty strings', async (t) => {
    const { baseUrl } = await startApi(t);
    for (const ids of [['tt-a', 5], ['tt-a', ''], ['tt-a', null], ['tt-a', 'x'.repeat(101)]]) {
      const res = await postCompare(baseUrl, { timetableIds: ids, criterion: 'leastGaps' });
      assert.equal(res.status, 400);
      assert.deepEqual(detailCodes(res.body), ['INVALID_TIMETABLE_ID']);
    }
  });

  test('rejects a missing timetableIds list or a body that is not an object', async (t) => {
    const { baseUrl } = await startApi(t);
    const missing = await postCompare(baseUrl, { criterion: 'leastGaps' });
    assert.equal(missing.status, 400);
    assert.deepEqual(detailCodes(missing.body), ['INVALID_INPUT']);

    const array = await postCompare(baseUrl, ['tt-a', 'tt-b']);
    assert.equal(array.status, 400);
    assert.deepEqual(detailCodes(array.body), ['INVALID_INPUT']);
  });

  test('rejects a body that is not valid JSON', async (t) => {
    const { baseUrl } = await startApi(t);
    const res = await postCompare(baseUrl, '{"timetableIds": [');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_JSON');
  });
});

describe('POST /api/compare - authentication (401 / 503)', () => {
  test('rejects a request with no login token', async (t) => {
    const { baseUrl, fakeService } = await startApi(t);
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' }, { token: null });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'AUTH_REQUIRED');
    assert.equal(fakeService.calls.length, 0);
  });

  test('rejects a badly formed Authorization header', async (t) => {
    const { baseUrl } = await startApi(t);
    for (const authorization of ['Bearer', `Token ${TOKEN_A}`, TOKEN_A, 'Bearer a b']) {
      const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' }, { authorization });
      assert.equal(res.status, 401, `header "${authorization}" should be rejected`);
      assert.equal(res.body.error.code, 'AUTH_REQUIRED');
    }
  });

  test('rejects an invalid login token', async (t) => {
    const { baseUrl, fakeService } = await startApi(t);
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' }, { token: 'made-up-token' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'INVALID_TOKEN');
    assert.equal(fakeService.calls.length, 0);
  });

  test('treats an error inside token verification as an invalid token', async (t) => {
    const verifyToken = async () => {
      throw new Error('verification failed');
    };
    const { baseUrl } = await startApi(t, { appOptions: { verifyToken } });
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'INVALID_TOKEN');
  });

  test('fails closed when no token verification is configured', async (t) => {
    const { baseUrl, fakeService } = await startApi(t, { appOptions: { verifyToken: undefined } });
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'AUTH_NOT_CONFIGURED');
    assert.equal(fakeService.calls.length, 0);
  });

  test('returns 401 when the Timetable Service rejects the token', async (t) => {
    const { baseUrl } = await startApi(t);
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' }, { token: 'test-token-revoked' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'INVALID_TOKEN');
  });
});

describe('POST /api/compare - ownership and missing timetables (404)', () => {
  test('returns 404 when a timetable does not exist', async (t) => {
    const { baseUrl } = await startApi(t);
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-missing'], criterion: 'leastGaps' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'TIMETABLE_NOT_FOUND');
  });

  test('returns 404 for another student\'s timetable', async (t) => {
    const { baseUrl } = await startApi(t);
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-other'], criterion: 'leastGaps' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'TIMETABLE_NOT_FOUND');
  });

  test('a user id in the body cannot be used to reach another student\'s timetable', async (t) => {
    const { baseUrl } = await startApi(t);
    const res = await postCompare(baseUrl, {
      timetableIds: ['tt-a', 'tt-other'],
      criterion: 'leastGaps',
      userId: 'student-b',
      ownerId: 'student-b'
    });
    assert.equal(res.status, 404);
  });

  test('still returns 404 if the Timetable Service wrongly returns another student\'s timetable', async (t) => {
    const fakeService = createFakeTimetableFetch({ mode: 'ignoresOwnership' });
    const { baseUrl } = await startApi(t, { fakeService });
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-other'], criterion: 'leastGaps' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'TIMETABLE_NOT_FOUND');
  });
});

describe('POST /api/compare - stale and invalid timetables', () => {
  test('returns 409 for a stale timetable', async (t) => {
    const { baseUrl } = await startApi(t);
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-stale'], criterion: 'leastGaps' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'STALE_TIMETABLE');
    assert.deepEqual(detailCodes(res.body), ['STALE_TIMETABLE']);
    assert.equal(res.body.error.details[0].timetableId, 'tt-stale');
  });
});

describe('POST /api/compare - Timetable Service problems (502 / 503)', () => {
  test('returns 503 when the Timetable Service cannot be reached', async (t) => {
    const fakeService = createFakeTimetableFetch({ mode: 'down' });
    const { baseUrl } = await startApi(t, { fakeService });
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'TIMETABLE_SERVICE_UNAVAILABLE');
  });

  test('returns 503 when the Timetable Service times out', async (t) => {
    const fakeService = createFakeTimetableFetch({ mode: 'slow' });
    const { baseUrl } = await startApi(t, { fakeService, timeoutMs: 50 });
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'TIMETABLE_SERVICE_UNAVAILABLE');
  });

  test('returns 502 when the Timetable Service answers with a server error', async (t) => {
    const fakeService = createFakeTimetableFetch({ mode: 'serverError' });
    const { baseUrl } = await startApi(t, { fakeService });
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' });
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'TIMETABLE_SERVICE_BAD_RESPONSE');
  });

  test('returns 502 when the Timetable Service sends invalid JSON', async (t) => {
    const fakeService = createFakeTimetableFetch({ mode: 'invalidJson' });
    const { baseUrl } = await startApi(t, { fakeService });
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' });
    assert.equal(res.status, 502);
  });

  test('returns 502 when the Timetable Service sends back the wrong timetable', async (t) => {
    const fakeService = createFakeTimetableFetch({ mode: 'wrongId' });
    const { baseUrl } = await startApi(t, { fakeService });
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' });
    assert.equal(res.status, 502);
  });
});

describe('Compare API - other behaviour', () => {
  test('hides internal error details behind a 500', async (t) => {
    const brokenClient = {
      getTimetable: async () => {
        throw new Error('internal secret detail');
      }
    };
    const { baseUrl } = await startApi(t, { appOptions: { timetableClient: brokenClient } });
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
    assert.doesNotMatch(res.text, /internal secret detail|at .*\.js/);
  });

  test('unknown endpoints return 404 in the same error format', async (t) => {
    const { baseUrl } = await startApi(t);
    const response = await fetch(`${baseUrl}/api/unknown`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
  });

  test('the Timetable Service client refuses to start without a URL', () => {
    assert.throws(() => createTimetableClient({ baseUrl: '' }), /not configured/);
    assert.throws(() => createTimetableClient({}), /not configured/);
  });

  test('timetable ids are URL-encoded before being sent upstream', async () => {
    const fakeService = createFakeTimetableFetch();
    const client = createTimetableClient({ baseUrl: `${FAKE_SERVICE_URL}/`, fetchFn: fakeService.fetchFn });
    await client.getTimetable('../admin?x=1', TOKEN_A);
    assert.equal(fakeService.calls[0].url, `${FAKE_SERVICE_URL}/api/timetables/..%2Fadmin%3Fx%3D1`);
  });
});

describe('Compare API - review fixes', () => {
  // Changes only tt-b, so tt-a stays a normal, valid timetable.
  function changeTimetableB(change) {
    return createFakeTimetableFetch({
      transform: (timetable) => {
        if (timetable.id === 'tt-b') {
          change(timetable);
        }
        return timetable;
      }
    });
  }

  test('rejects unsafe timetable ids before calling the Timetable Service', async (t) => {
    const { baseUrl, fakeService } = await startApi(t);
    const unsafeIds = ['.', '..', ' tt-b', 'tt-b ', '\ttt-b', 'tt\u0000b', 'tt\nb', 'tt\u007fb', 'tt\u0085b'];
    for (const unsafeId of unsafeIds) {
      const res = await postCompare(baseUrl, { timetableIds: ['tt-a', unsafeId], criterion: 'leastGaps' });
      assert.equal(res.status, 400, `id ${JSON.stringify(unsafeId)} should be rejected`);
      assert.deepEqual(detailCodes(res.body), ['INVALID_TIMETABLE_ID']);
    }
    assert.equal(fakeService.calls.length, 0);
  });

  test('keeps unusual but safe ids working and encodes them safely', async (t) => {
    const { baseUrl, fakeService } = await startApi(t);
    const res = await postCompare(baseUrl, {
      timetableIds: ['tt.1', 'a..b', '...', 'tt 2', 'TT_3-x'],
      criterion: 'leastGaps'
    });
    // These ids do not exist in the fake service, so 404 is expected,
    // but every one of them must have been requested at a safe URL.
    assert.equal(res.status, 404);
    assert.deepEqual(fakeService.calls.map((call) => call.url).sort(), [
      `${FAKE_SERVICE_URL}/api/timetables/...`,
      `${FAKE_SERVICE_URL}/api/timetables/TT_3-x`,
      `${FAKE_SERVICE_URL}/api/timetables/a..b`,
      `${FAKE_SERVICE_URL}/api/timetables/tt%202`,
      `${FAKE_SERVICE_URL}/api/timetables/tt.1`
    ]);
  });

  test('fails closed with 502 when ownerId is missing or malformed', async (t) => {
    const badOwners = [
      (timetable) => delete timetable.ownerId,
      (timetable) => (timetable.ownerId = null),
      (timetable) => (timetable.ownerId = ''),
      (timetable) => (timetable.ownerId = 42),
      (timetable) => (timetable.ownerId = { sub: 'student-a' }),
      (timetable) => (timetable.ownerId = ['student-a'])
    ];
    for (const change of badOwners) {
      const { baseUrl } = await startApi(t, { fakeService: changeTimetableB(change) });
      const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' });
      assert.equal(res.status, 502);
      assert.equal(res.body.error.code, 'TIMETABLE_SERVICE_BAD_RESPONSE');
    }
  });

  test('returns 404 when ownerId belongs to another user', async (t) => {
    const fakeService = changeTimetableB((timetable) => (timetable.ownerId = 'student-b'));
    const { baseUrl } = await startApi(t, { fakeService });
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'TIMETABLE_NOT_FOUND');
  });

  test('ownerId must match exactly (no case or space differences)', async (t) => {
    for (const ownerId of ['Student-A', 'student-a ', ' student-a']) {
      const fakeService = changeTimetableB((timetable) => (timetable.ownerId = ownerId));
      const { baseUrl } = await startApi(t, { fakeService });
      const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' });
      assert.equal(res.status, 404, `ownerId ${JSON.stringify(ownerId)} should not match`);
    }
  });

  test('returns 502, not 400, when the Timetable Service sends malformed timetable data', async (t) => {
    const malformed = [
      (timetable) => (timetable.sections = []),
      (timetable) => delete timetable.sections,
      (timetable) => (timetable.sections[0].meetings[0].day = 'FRI'),
      (timetable) => (timetable.sections[0].meetings[0].startTime = '9am'),
      (timetable) => (timetable.sections[1].meetings[0].startTime = '10:00'), // overlap
      (timetable) => (timetable.stale = 'yes'),
      (timetable) => (timetable.name = 42)
    ];
    for (const change of malformed) {
      const { baseUrl } = await startApi(t, { fakeService: changeTimetableB(change) });
      const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' });
      assert.equal(res.status, 502);
      assert.deepEqual(res.body, {
        error: { code: 'TIMETABLE_SERVICE_BAD_RESPONSE', message: 'The Timetable Service sent an invalid response' }
      });
      // No raw upstream data such as section ids is sent back.
      assert.doesNotMatch(res.text, /CS101|MATH201|tt-b/);
    }
  });

  test('a stale timetable is still 409, and its details hold only the code and id', async (t) => {
    const { baseUrl } = await startApi(t);
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-stale'], criterion: 'leastGaps' });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body.error.details, [{ code: 'STALE_TIMETABLE', timetableId: 'tt-stale' }]);
  });

  test('stale plus malformed data is reported as a bad upstream response', async (t) => {
    const fakeService = changeTimetableB((timetable) => (timetable.sections = []));
    const { baseUrl } = await startApi(t, { fakeService });
    const res = await postCompare(baseUrl, { timetableIds: ['tt-stale', 'tt-b'], criterion: 'leastGaps' });
    assert.equal(res.status, 502);
  });

  test('comparison results are unchanged by the fixes', async (t) => {
    const { baseUrl } = await startApi(t);
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b', 'tt-c'], criterion: 'latestStart' });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.results.map((r) => `${r.rank}:${r.timetableId}`),
      ['1:tt-c', '2:tt-a', '2:tt-b']
    );
  });

  test('unexpected errors are logged without the raw message or the token', async (t) => {
    const logLines = [];
    const brokenClient = {
      getTimetable: async (id, token) => {
        throw new Error(`failed with token ${token} and password hunter2`);
      }
    };
    const { baseUrl } = await startApi(t, {
      appOptions: { timetableClient: brokenClient, logError: (line) => logLines.push(line) }
    });
    const res = await postCompare(baseUrl, { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' });

    assert.equal(res.status, 500);
    assert.equal(logLines.length, 1);
    assert.deepEqual(JSON.parse(logLines[0]), {
      level: 'error',
      event: 'unexpected_error',
      method: 'POST',
      route: '/api/compare',
      errorType: 'Error'
    });
    assert.doesNotMatch(logLines[0], /hunter2|test-token-student-a/);
  });
});
