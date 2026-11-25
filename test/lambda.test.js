// Tests for the Lambda entry point (src/lambda.js) and the shared configuration
// (src/appFromEnv.js). SIMULATED: no Floci, no network; the app uses the usual
// test fakes and is driven with API Gateway HTTP API (v2) events.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createHandler, resetForTests } = require('../src/lambda');
const { buildAppFromEnv, ConfigError } = require('../src/appFromEnv');
const { createApp } = require('../src/app');
const { createTimetableClient } = require('../src/timetableClient');
const { testVerifyToken, createFakeTimetableFetch } = require('./fixtures/fakeTimetableService');
const { createFakeShareStore } = require('./fixtures/fakeShareStore');

afterEach(() => resetForTests());

function httpEvent(method, rawPath, { token, body } = {}) {
  const headers = { host: 'lambda.test' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString: '',
    headers,
    requestContext: { http: { method, path: rawPath, sourceIp: '127.0.0.1' }, stage: '$default' },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false
  };
}

function testApp() {
  return createApp({
    verifyToken: testVerifyToken,
    timetableClient: createTimetableClient({ baseUrl: 'http://timetable.test', fetchFn: createFakeTimetableFetch().fetchFn }),
    shareStore: createFakeShareStore(),
    calendarSettings: { termStart: '2026-09-13', termEnd: '2026-12-31', timeZone: 'Africa/Cairo' },
    logError: () => {}
  });
}

const VALID_ENV = {
  TIMETABLE_SERVICE_URL: 'http://timetable.test',
  CATALOGUE_JWKS_URL: 'http://catalogue.test/.well-known/jwks.json',
  SHARE_TABLE_NAME: 'share_links',
  AWS_REGION: 'us-east-1',
  TERM_START_DATE: '2026-09-13',
  TERM_END_DATE: '2026-12-31'
};

describe('Lambda handler', () => {
  test('runs the Express app: POST /api/compare with a valid token -> 200', async () => {
    const handler = createHandler({ buildApp: testApp });
    const res = await handler(httpEvent('POST', '/api/compare', { token: 'test-token-student-a', body: { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' } }), {});
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).results.length, 2);
  });

  test('keeps authentication: no token -> 401 AUTH_REQUIRED, bad token -> 401 INVALID_TOKEN', async () => {
    const handler = createHandler({ buildApp: testApp });
    const none = await handler(httpEvent('GET', '/api/shares'), {});
    assert.equal(none.statusCode, 401);
    assert.equal(JSON.parse(none.body).error.code, 'AUTH_REQUIRED');
    const bad = await handler(httpEvent('GET', '/api/shares', { token: 'made-up' }), {});
    assert.equal(bad.statusCode, 401);
    assert.equal(JSON.parse(bad.body).error.code, 'INVALID_TOKEN');
  });

  test('keeps ownership checks: another student\'s timetable -> 404', async () => {
    const handler = createHandler({ buildApp: testApp });
    const res = await handler(httpEvent('POST', '/api/shares', { token: 'test-token-student-b', body: { timetableId: 'tt-a', expiresInDays: 7 } }), {});
    assert.equal(res.statusCode, 404);
  });

  test('keeps the security headers', async () => {
    const handler = createHandler({ buildApp: testApp });
    const res = await handler(httpEvent('GET', '/api/shares'), {});
    const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v]));
    assert.match(headers['content-security-policy'], /default-src 'self'/);
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['x-powered-by'], undefined);
  });

  test('builds the app once and reuses it for later invocations', async () => {
    let builds = 0;
    const handler = createHandler({ buildApp: () => { builds += 1; return testApp(); } });
    await handler(httpEvent('GET', '/api/shares'), {});
    await handler(httpEvent('GET', '/api/shares'), {});
    assert.equal(builds, 1);
  });

  test('fails closed when the configuration is invalid (no request is served)', async () => {
    const handler = createHandler({ buildApp: () => buildAppFromEnv({}) });
    await assert.rejects(handler(httpEvent('GET', '/api/shares', { token: 'test-token-student-a' }), {}), ConfigError);
  });

  test('the exported default handler fails closed without settings', async () => {
    const saved = { ...process.env };
    for (const name of Object.keys(VALID_ENV)) delete process.env[name];
    try {
      const { handler } = require('../src/lambda');
      await assert.rejects(handler(httpEvent('GET', '/api/shares'), {}), ConfigError);
    } finally {
      Object.assign(process.env, saved);
    }
  });
});

describe('appFromEnv - shared configuration', () => {
  test('builds the app with valid settings', () => {
    const app = buildAppFromEnv(VALID_ENV, { warn: () => {} });
    assert.equal(typeof app, 'function');
  });

  test('refuses missing or invalid required settings', () => {
    const cases = [
      [{ ...VALID_ENV, TIMETABLE_SERVICE_URL: '' }, /TIMETABLE_SERVICE_URL/],
      [{ ...VALID_ENV, CATALOGUE_JWKS_URL: '' }, /CATALOGUE_JWKS_URL/],
      [{ ...VALID_ENV, CATALOGUE_JWKS_URL: 'ftp://x/jwks.json' }, /CATALOGUE_JWKS_URL/],
      [{ ...VALID_ENV, CATALOGUE_JWKS_URL: 'http://user:pw@x/jwks.json' }, /CATALOGUE_JWKS_URL/],
      [{ ...VALID_ENV, SHARE_TABLE_NAME: '' }, /SHARE_TABLE_NAME/],
      [{ ...VALID_ENV, AWS_REGION: '' }, /AWS_REGION/]
    ];
    for (const [env, message] of cases) {
      assert.throws(() => buildAppFromEnv(env, { warn: () => {} }), (err) => err instanceof ConfigError && message.test(err.message));
    }
  });

  test('invalid term dates only produce a warning (calendar disabled)', () => {
    const warnings = [];
    buildAppFromEnv({ ...VALID_ENV, TERM_START_DATE: 'soon' }, { warn: (m) => warnings.push(m) });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Calendar export disabled/);
  });
});

describe('local server still starts the same way', () => {
  test('node src/server.js exits with a clear message when a setting is missing', () => {
    const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, TIMETABLE_SERVICE_URL: 'http://localhost:3002', CATALOGUE_JWKS_URL: '', SHARE_TABLE_NAME: '', AWS_REGION: '' },
      encoding: 'utf8',
      timeout: 15000
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /CATALOGUE_JWKS_URL is missing or invalid/);
  });
});
