// Tests for the structured request log (src/requestLogger.js).
// SIMULATED: test fakes for login, timetables and storage; no CloudWatch.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { createApp } = require('../src/app');
const { createTimetableClient } = require('../src/timetableClient');
const { createHandler, resetForTests } = require('../src/lambda');
const { classify } = require('../src/requestLogger');
const { testVerifyToken, createFakeTimetableFetch } = require('./fixtures/fakeTimetableService');
const { createFakeShareStore } = require('./fixtures/fakeShareStore');
const { ShareStoreError } = require('../src/shareStore');

const SHARE_TOKEN = 'S'.repeat(20) + '_secret-' + 'T'.repeat(15); // 43 chars, looks like a real token

function buildApp({ lines, shareStore = createFakeShareStore(), mode } = {}) {
  return createApp({
    verifyToken: testVerifyToken,
    timetableClient: createTimetableClient({ baseUrl: 'http://timetable.test', fetchFn: createFakeTimetableFetch({ mode }).fetchFn }),
    shareStore,
    calendarSettings: { termStart: '2026-09-13', termEnd: '2026-12-31', timeZone: 'Africa/Cairo' },
    logError: () => {},
    logRequest: (line) => lines.push(line)
  });
}

async function start(t, options) {
  const lines = [];
  const app = buildApp({ lines, ...options });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => server.close(r)));
  return { base: `http://127.0.0.1:${server.address().port}`, lines };
}

async function call(base, method, path, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers: h, body: typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body) });
  await res.text();
  return res.status;
}

// Waits for the "finish" event to be logged.
const settle = () => new Promise((r) => setImmediate(r));
const parsed = (lines) => lines.map((l) => JSON.parse(l));

describe('request log - one safe line per API request', () => {
  test('success: method, route pattern, status, duration, outcome ok', async (t) => {
    const { base, lines } = await start(t);
    assert.equal(await call(base, 'POST', '/api/compare', { token: 'test-token-student-a', body: { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' } }), 200);
    await settle();
    const [entry] = parsed(lines);
    assert.equal(entry.event, 'http.request');
    assert.equal(entry.method, 'POST');
    assert.equal(entry.route, '/api/compare');
    assert.equal(entry.status, 200);
    assert.equal(entry.outcome, 'ok');
    assert.equal(entry.level, 'info');
    assert.equal(typeof entry.durationMs, 'number');
    assert.match(entry.requestId, /^[0-9a-f-]{36}$/);
    assert.ok(!Number.isNaN(Date.parse(entry.time)));
    assert.equal('errorCode' in entry, false);
    assert.deepEqual(Object.keys(entry).sort(), ['durationMs', 'event', 'level', 'method', 'outcome', 'requestId', 'route', 'status', 'time']);
  });

  test('authentication failures are labelled with their code', async (t) => {
    const { base, lines } = await start(t);
    await call(base, 'GET', '/api/shares');
    await call(base, 'GET', '/api/shares', { token: 'made-up-token' });
    await settle();
    const entries = parsed(lines);
    assert.deepEqual(entries.map((e) => [e.status, e.outcome, e.errorCode]), [[401, 'auth_failure', 'AUTH_REQUIRED'], [401, 'auth_failure', 'INVALID_TOKEN']]);
  });

  test('ownership failures and invalid input are labelled', async (t) => {
    const { base, lines } = await start(t);
    await call(base, 'POST', '/api/shares', { token: 'test-token-student-b', body: { timetableId: 'tt-a', expiresInDays: 7 } });
    await call(base, 'POST', '/api/shares', { token: 'test-token-student-a', body: { timetableId: '', expiresInDays: 99 } });
    await call(base, 'POST', '/api/compare', { token: 'test-token-student-a', body: '{"broken' });
    await settle();
    assert.deepEqual(parsed(lines).map((e) => [e.status, e.outcome, e.errorCode]), [
      [404, 'not_found_or_not_owner', 'TIMETABLE_NOT_FOUND'],
      [400, 'client_error', 'INVALID_REQUEST'],
      [400, 'client_error', 'INVALID_JSON']
    ]);
  });

  test('dependency failures are labelled (timetable service down, storage down)', async (t) => {
    const { base, lines } = await start(t, { mode: 'down' });
    await call(base, 'POST', '/api/compare', { token: 'test-token-student-a', body: { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' } });
    const failingStore = { ...createFakeShareStore(), listSharesByOwner: async () => { throw new ShareStoreError('listSharesByOwner', new Error('ECONNREFUSED 10.0.0.1:4566')); } };
    const second = await start(t, { shareStore: failingStore });
    await call(second.base, 'GET', '/api/shares', { token: 'test-token-student-a' });
    await settle();
    assert.deepEqual(parsed(lines).map((e) => [e.status, e.outcome, e.errorCode]), [[503, 'dependency_failure', 'TIMETABLE_SERVICE_UNAVAILABLE']]);
    const [storage] = parsed(second.lines);
    assert.deepEqual([storage.status, storage.outcome, storage.errorCode, storage.level], [503, 'dependency_failure', 'SHARE_STORAGE_UNAVAILABLE', 'error']);
    assert.ok(!second.lines[0].includes('ECONNREFUSED'));
  });

  test('share tokens, JWTs, headers, query strings and bodies never appear', async (t) => {
    const { base, lines } = await start(t);
    const jwtLike = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzZWNyZXQtdXNlciJ9.c2lnbmF0dXJlLXNlY3JldA';
    await call(base, 'GET', `/api/shares/${SHARE_TOKEN}?email=someone@example.edu`, { token: 'test-token-student-a', headers: { Cookie: '__Secure-refresh=cookie-secret-value', 'X-Request-Id': 'attacker-chosen-id-1234' } });
    await call(base, 'GET', `/api/shares/${SHARE_TOKEN}/calendar.ics`, { token: jwtLike });
    await call(base, 'POST', '/api/shares', { token: 'test-token-student-a', body: { timetableId: 'tt-a', expiresInDays: 7, note: 'body-secret-text' } });
    await call(base, 'DELETE', `/api/shares/${SHARE_TOKEN}`, { token: 'test-token-student-a' });
    await settle();
    const all = lines.join('\n');
    for (const secret of [SHARE_TOKEN, 'secret', 'someone@example.edu', 'cookie-secret-value', 'attacker-chosen-id', jwtLike, 'test-token-student-a', 'body-secret-text', 'student-a', 'Bearer', 'email=']) {
      assert.ok(!all.includes(secret), `log must not contain ${secret}`);
    }
    assert.deepEqual(parsed(lines).map((e) => e.route), ['/api/shares/:token', '/api/shares/:token/calendar.ics', '/api/shares', '/api/shares/:token']);
  });

  test('unknown routes and odd methods use fixed labels; pages are not logged', async (t) => {
    const { base, lines } = await start(t);
    await call(base, 'GET', '/api/secret-path/abc123');
    await call(base, 'PROPFIND', '/api/shares');
    await call(base, 'GET', '/index.html');
    await settle();
    const entries = parsed(lines);
    assert.equal(entries.length, 2, 'the page request is not logged');
    assert.equal(entries[0].route, 'unmatched');
    assert.ok(!lines[0].includes('secret-path'));
    assert.equal(entries[1].method, 'OTHER');
  });

  test('outcome labels', () => {
    assert.equal(classify(200), 'ok');
    assert.equal(classify(201), 'ok');
    assert.equal(classify(400, 'INVALID_REQUEST'), 'client_error');
    assert.equal(classify(401, 'INVALID_TOKEN'), 'auth_failure');
    assert.equal(classify(404, 'SHARE_NOT_FOUND'), 'not_found_or_not_owner');
    assert.equal(classify(503, 'AUTH_SERVICE_UNAVAILABLE'), 'dependency_failure');
    assert.equal(classify(500, 'INTERNAL_ERROR'), 'server_error');
  });
});

describe('request log inside Lambda', () => {
  test('uses the Lambda runtime request id, never the client x-request-id header', async () => {
    resetForTests();
    const lines = [];
    const handler = createHandler({ buildApp: () => buildApp({ lines }) });
    const event = {
      version: '2.0', routeKey: '$default', rawPath: '/api/shares', rawQueryString: '',
      headers: { host: 'x', 'x-request-id': 'attacker-chosen-id-1234' },
      requestContext: { requestId: 'apigw-req-1', http: { method: 'GET', path: '/api/shares', sourceIp: '127.0.0.1' }, stage: '$default' },
      isBase64Encoded: false
    };
    const res = await handler(event, { awsRequestId: '11111111-2222-3333-4444-555555555555' });
    assert.equal(res.statusCode, 401);
    await settle();
    const [entry] = parsed(lines);
    assert.equal(entry.requestId, '11111111-2222-3333-4444-555555555555');
    assert.ok(!lines[0].includes('attacker'));
    resetForTests();
  });
});
