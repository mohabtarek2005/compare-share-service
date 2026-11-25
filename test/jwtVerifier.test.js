// Tests for the JWKS-based login token verifier (src/jwtVerifier.js).
//
// SIMULATED: every test here uses RSA keys generated in memory and a fake
// JWKS endpoint. None of them talk to Mohamed's running Catalogue Service.
// The "compatibility" suite at the end imports Mohamed's real token-signing
// module (read-only, no files changed, no real keys) to prove that tokens made
// by his code pass this verifier.

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { once } = require('node:events');

const { createJwksVerifier, AuthUnavailableError } = require('../src/jwtVerifier');
const { createApp } = require('../src/app');
const { createTimetableClient } = require('../src/timetableClient');
const { createFakeTimetableFetch } = require('./fixtures/fakeTimetableService');
const { createFakeShareStore } = require('./fixtures/fakeShareStore');
const { createTestKey, signTestToken, createFakeJwksServer, encodePart } = require('./fixtures/jwtTestKeys');

const JWKS_URL = 'http://catalogue.test/.well-known/jwks.json';
const NOW_MS = Date.parse('2026-11-24T12:00:00.000Z');
const NOW = NOW_MS / 1000;

let keyA;
let keyB;
let weakKey;

before(() => {
  keyA = createTestKey();
  keyB = createTestKey();
  weakKey = createTestKey(1024);
});

// Builds a verifier with a fake JWKS server and a clock the test controls.
function setup({ keys = [keyA], options = {} } = {}) {
  const jwks = createFakeJwksServer(keys);
  const clock = { ms: NOW_MS };
  const logs = [];
  const verifyToken = createJwksVerifier({
    jwksUrl: JWKS_URL,
    fetchFn: jwks.fetchFn,
    now: () => clock.ms,
    log: (entry) => logs.push(entry),
    ...options
  });
  return { verifyToken, jwks, clock, logs, advance: (ms) => (clock.ms += ms) };
}

function token(claims = {}, header = {}, key = keyA) {
  return signTestToken(key, { claims, header, nowSeconds: NOW });
}

describe('JWT verifier - valid tokens', () => {
  test('accepts a valid RS256 student token and returns only verified claims', async () => {
    const { verifyToken } = setup();
    const jti = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const user = await verifyToken(token({ jti }));
    assert.deepEqual(user, {
      sub: '11111111-2222-3333-4444-555555555555',
      role: 'student',
      jti,
      exp: NOW + 7200
    });
    assert.ok(Object.isFrozen(user));
  });

  test('accepts an admin token', async () => {
    const { verifyToken } = setup();
    const user = await verifyToken(token({ role: 'admin' }));
    assert.equal(user.role, 'admin');
  });

  test('ignores extra claims such as email instead of passing them on', async () => {
    const { verifyToken } = setup();
    const user = await verifyToken(token({ email: 'someone@example.edu', isAdmin: true }));
    assert.deepEqual(Object.keys(user).sort(), ['exp', 'jti', 'role', 'sub']);
  });
});

describe('JWT verifier - signature and algorithm', () => {
  test('rejects a token whose payload was changed after signing', async () => {
    const { verifyToken } = setup();
    const [h, , s] = token().split('.');
    const forgedPayload = encodePart({ iss: 'class-tt', aud: 'class-tt', sub: 'someone-else', role: 'admin', iat: NOW, exp: NOW + 7200, jti: 'x' });
    assert.equal(await verifyToken(`${h}.${forgedPayload}.${s}`), null);
  });

  test('rejects a token signed by a different key that claims a published kid', async () => {
    const { verifyToken } = setup();
    const forged = signTestToken(keyB, { header: { kid: keyA.kid }, nowSeconds: NOW });
    assert.equal(await verifyToken(forged), null);
  });

  test('rejects unsigned tokens and "alg: none"', async () => {
    const { verifyToken } = setup();
    const [, p] = token().split('.');
    const noneHeader = encodePart({ alg: 'none', typ: 'JWT', kid: keyA.kid });
    assert.equal(await verifyToken(`${noneHeader}.${p}.`), null);
    assert.equal(await verifyToken(`${noneHeader}.${p}.c2lnbmF0dXJl`), null);
  });

  test('rejects HS256 tokens signed with the public key as an HMAC secret', async () => {
    const { verifyToken } = setup();
    const header = encodePart({ alg: 'HS256', typ: 'JWT', kid: keyA.kid });
    const [, p] = token().split('.');
    const publicPem = crypto.createPublicKey({ key: keyA.publicJwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
    const mac = crypto.createHmac('sha256', publicPem).update(`${header}.${p}`).digest('base64url');
    assert.equal(await verifyToken(`${header}.${p}.${mac}`), null);
  });

  test('rejects other algorithms and a missing alg', async () => {
    const { verifyToken } = setup();
    for (const alg of ['RS512', 'PS256', 'ES256', 'rs256', undefined]) {
      assert.equal(await verifyToken(token({}, { alg })), null, `alg ${alg} should be rejected`);
    }
  });

  test('rejects an unexpected typ and a crit header', async () => {
    const { verifyToken } = setup();
    assert.equal(await verifyToken(token({}, { typ: 'at+jwt' })), null);
    assert.equal(await verifyToken(token({}, { crit: ['exp'] })), null);
  });
});

describe('JWT verifier - kid', () => {
  test('rejects a missing, empty or non-string kid without fetching keys', async () => {
    const { verifyToken, jwks } = setup();
    for (const kid of [undefined, '', 123, 'has space']) {
      assert.equal(await verifyToken(token({}, { kid })), null);
    }
    assert.equal(jwks.state.calls.length, 0);
  });

  test('rejects an unknown kid', async () => {
    const { verifyToken } = setup();
    assert.equal(await verifyToken(token({}, { kid: 'not-a-published-kid' })), null);
  });
});

describe('JWT verifier - time claims and clock skew (60 seconds)', () => {
  test('exp: accepted up to 60 seconds after expiry, rejected after that', async () => {
    const { verifyToken } = setup();
    assert.ok(await verifyToken(token({ exp: NOW - 60 })), 'exactly 60 s late is accepted');
    assert.equal(await verifyToken(token({ exp: NOW - 61 })), null, '61 s late is rejected');
  });

  test('a normal 2-hour token stops working 2 hours and 60 seconds after issue', async () => {
    const { verifyToken, advance } = setup();
    const t = token();
    advance((7200 + 60) * 1000);
    assert.ok(await verifyToken(t));
    advance(1000);
    assert.equal(await verifyToken(t), null);
  });

  test('iat: up to 60 seconds in the future is accepted, more is rejected', async () => {
    const { verifyToken } = setup();
    assert.ok(await verifyToken(token({ iat: NOW + 60 })));
    assert.equal(await verifyToken(token({ iat: NOW + 61 })), null);
  });

  test('rejects missing or non-numeric exp and iat', async () => {
    const { verifyToken } = setup();
    for (const claims of [{ exp: undefined }, { exp: String(NOW + 100) }, { iat: undefined }, { iat: 'yesterday' }, { exp: null }]) {
      assert.equal(await verifyToken(token(claims)), null, JSON.stringify(claims));
    }
  });

  test('respects nbf when present', async () => {
    const { verifyToken } = setup();
    assert.ok(await verifyToken(token({ nbf: NOW + 60 })));
    assert.equal(await verifyToken(token({ nbf: NOW + 61 })), null);
    assert.equal(await verifyToken(token({ nbf: 'soon' })), null);
  });
});

describe('JWT verifier - issuer, audience, subject, role, jti', () => {
  test('rejects a wrong or missing issuer', async () => {
    const { verifyToken } = setup();
    for (const iss of ['other-issuer', 'CLASS-TT', undefined]) {
      assert.equal(await verifyToken(token({ iss })), null);
    }
  });

  test('rejects a wrong, missing or array audience', async () => {
    const { verifyToken } = setup();
    for (const aud of ['timetable', undefined, ['class-tt'], ['class-tt', 'other']]) {
      assert.equal(await verifyToken(token({ aud })), null, JSON.stringify(aud));
    }
  });

  test('rejects a missing or invalid subject', async () => {
    const { verifyToken } = setup();
    for (const sub of [undefined, '', 42, null, 'a'.repeat(65), 'has space', 'tab\tinside']) {
      assert.equal(await verifyToken(token({ sub })), null, JSON.stringify(sub));
    }
  });

  test('rejects any role other than student or admin', async () => {
    const { verifyToken } = setup();
    for (const role of ['teacher', 'ADMIN', 'Student', '', undefined, ['admin']]) {
      assert.equal(await verifyToken(token({ role })), null, JSON.stringify(role));
    }
  });

  test('rejects a missing jti', async () => {
    const { verifyToken } = setup();
    assert.equal(await verifyToken(token({ jti: undefined })), null);
  });
});

describe('JWT verifier - malformed tokens', () => {
  test('rejects tokens that are not three base64url parts', async () => {
    const { verifyToken, jwks } = setup();
    const valid = token();
    const bad = [
      undefined,
      null,
      '',
      'short',
      'a'.repeat(30),
      'aaaaaaaaaa.bbbbbbbbbb',
      `${valid}.extra`,
      valid.replace('.', '.+'),
      `${valid.slice(0, 20)}=${valid.slice(20)}`,
      'a'.repeat(4097)
    ];
    for (const value of bad) {
      assert.equal(await verifyToken(value), null);
    }
    assert.equal(jwks.state.calls.length, 0, 'malformed tokens never trigger a key fetch');
  });

  test('rejects a header or payload that is not a JSON object', async () => {
    const { verifyToken } = setup();
    const [h, p, s] = token().split('.');
    assert.equal(await verifyToken(`${encodePart('not json at all')}.${p}.${s}`), null);
    assert.equal(await verifyToken(`${encodePart('[1,2,3]')}.${p}.${s}`), null);
    // A correctly signed token whose payload is not an object.
    const arrayPayload = encodePart('["x"]');
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${arrayPayload}`), keyA.privateKey).toString('base64url');
    assert.equal(await verifyToken(`${h}.${arrayPayload}.${sig}`), null);
  });
});

describe('JWT verifier - key caching and rotation', () => {
  test('fetches the key set once and reuses it for 10 minutes', async () => {
    const { verifyToken, jwks, advance } = setup();
    assert.ok(await verifyToken(token()));
    assert.ok(await verifyToken(token()));
    advance(9 * 60 * 1000);
    assert.ok(await verifyToken(token({ iat: NOW + 9 * 60, exp: NOW + 9 * 60 + 7200 })));
    assert.equal(jwks.state.calls.length, 1);
    advance(61 * 1000);
    assert.ok(await verifyToken(token({ iat: NOW + 10 * 60, exp: NOW + 10 * 60 + 7200 })));
    assert.equal(jwks.state.calls.length, 2, 'refetched after 10 minutes');
  });

  test('only ever calls the configured JWKS URL with a timeout and no redirects', async () => {
    const { verifyToken, jwks } = setup();
    await verifyToken(token());
    const [call] = jwks.state.calls;
    assert.equal(call.url, JWKS_URL);
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal instanceof AbortSignal);
  });

  test('concurrent first requests share one key fetch', async () => {
    const { verifyToken, jwks } = setup();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => verifyToken(token())));
    assert.ok(results.every(Boolean));
    assert.equal(jwks.state.calls.length, 1);
  });

  test('key rotation: a new kid triggers a refetch, and the old key keeps working while published', async () => {
    const { verifyToken, jwks, advance } = setup({ keys: [keyA] });
    assert.ok(await verifyToken(token()));
    jwks.setKeys([keyB, keyA]); // Mohamed rotates: newest first, old one kept
    advance(31 * 1000);
    assert.ok(await verifyToken(token({}, {}, keyB)), 'token from the new key accepted');
    assert.ok(await verifyToken(token()), 'token from the old key still accepted');
    assert.equal(jwks.state.calls.length, 2);
  });

  test('a retired key that is no longer published stops working after the next refresh', async () => {
    const { verifyToken, jwks, advance } = setup({ keys: [keyA] });
    assert.ok(await verifyToken(token()));
    jwks.setKeys([keyB]);
    advance(10 * 60 * 1000 + 1);
    assert.equal(await verifyToken(token({ iat: NOW + 600, exp: NOW + 600 + 7200 })), null);
  });

  test('unknown kids cannot force more than one refetch every 30 seconds', async () => {
    const { verifyToken, jwks, advance } = setup();
    await verifyToken(token());
    assert.equal(jwks.state.calls.length, 1);
    advance(31 * 1000);
    for (let i = 0; i < 20; i++) {
      assert.equal(await verifyToken(token({}, { kid: `made-up-${i}` })), null);
    }
    assert.equal(jwks.state.calls.length, 2, 'only one extra fetch for 20 made-up kids');
    advance(31 * 1000);
    await verifyToken(token({}, { kid: 'made-up-again' }));
    assert.equal(jwks.state.calls.length, 3);
  });

  test('an unknown kid while the Catalogue is down is just an invalid token (cached keys still fresh)', async () => {
    const { verifyToken, jwks, advance } = setup();
    await verifyToken(token());
    jwks.state.mode = 'down';
    advance(31 * 1000);
    assert.equal(await verifyToken(token({}, { kid: 'new-kid' })), null);
    assert.ok(await verifyToken(token()), 'known kid still verifies from the cache');
  });
});

describe('JWT verifier - JWKS problems fail closed', () => {
  async function assertUnavailable(promise, reason) {
    await assert.rejects(promise, (err) => {
      assert.ok(err instanceof AuthUnavailableError);
      assert.equal(err.authUnavailable, true);
      if (reason) assert.equal(err.reason, reason);
      assert.equal(err.message, 'Authentication service unavailable');
      return true;
    });
  }

  test('Catalogue unreachable', async () => {
    const { verifyToken, jwks } = setup();
    jwks.state.mode = 'down';
    await assertUnavailable(verifyToken(token()), 'jwks_unreachable');
  });

  test('JWKS request times out', async () => {
    const { verifyToken, jwks } = setup({ options: { timeoutMs: 50 } });
    jwks.state.mode = 'slow';
    await assertUnavailable(verifyToken(token()), 'jwks_timeout');
  });

  test('JWKS answers with an error status', async () => {
    const { verifyToken, jwks } = setup();
    jwks.state.status = 500;
    await assertUnavailable(verifyToken(token()), 'jwks_bad_status');
  });

  test('JWKS response is not JSON', async () => {
    const { verifyToken, jwks } = setup();
    jwks.state.body = '<html>oops</html>';
    await assertUnavailable(verifyToken(token()), 'jwks_not_json');
  });

  test('JWKS response has no usable keys', async () => {
    const shapes = [
      '{}',
      '{"keys":"nope"}',
      '{"keys":[]}',
      JSON.stringify({ keys: [{ ...keyA.publicJwk, kty: 'EC' }] }),
      JSON.stringify({ keys: [{ ...keyA.publicJwk, alg: 'HS256' }] }),
      JSON.stringify({ keys: [{ ...keyA.publicJwk, use: 'enc' }] }),
      JSON.stringify({ keys: [{ ...keyA.publicJwk, n: 'not base64url!' }] }),
      JSON.stringify({ keys: [{ ...keyA.publicJwk, kid: undefined }] }),
      JSON.stringify({ keys: [weakKey.publicJwk] }),
      JSON.stringify({ keys: new Array(21).fill(keyA.publicJwk) })
    ];
    for (const body of shapes) {
      const { verifyToken, jwks } = setup();
      jwks.state.body = body;
      await assertUnavailable(verifyToken(token()), 'jwks_no_usable_keys');
    }
  });

  test('JWKS response that is too large', async () => {
    const { verifyToken, jwks } = setup();
    jwks.state.body = JSON.stringify({ keys: [keyA.publicJwk], padding: 'x'.repeat(110 * 1024) });
    await assertUnavailable(verifyToken(token()), 'jwks_too_large');
  });

  test('bad entries are skipped when at least one key is usable', async () => {
    const { verifyToken, jwks } = setup();
    jwks.state.body = JSON.stringify({ keys: [{ kty: 'EC', kid: 'x' }, null, weakKey.publicJwk, keyA.publicJwk] });
    assert.ok(await verifyToken(token()));
    assert.equal(await verifyToken(token({}, {}, weakKey)), null, 'a 1024-bit key is never trusted');
  });

  test('after a failed fetch, retries wait 30 seconds instead of calling on every request', async () => {
    const { verifyToken, jwks, advance } = setup();
    jwks.state.mode = 'down';
    await assertUnavailable(verifyToken(token()));
    await assertUnavailable(verifyToken(token()), 'jwks_retry_wait');
    assert.equal(jwks.state.calls.length, 1);
    jwks.state.mode = 'normal';
    advance(31 * 1000);
    assert.ok(await verifyToken(token()));
    assert.equal(jwks.state.calls.length, 2);
  });

  test('once the 10-minute cache expires and the Catalogue is down, verification fails closed', async () => {
    const { verifyToken, jwks, advance } = setup();
    const t = token();
    assert.ok(await verifyToken(t));
    jwks.state.mode = 'down';
    advance(10 * 60 * 1000 + 1);
    await assertUnavailable(verifyToken(t));
  });
});

describe('JWT verifier - bypass attempts and safe logging', () => {
  test('ignores key locations inside the token (jku, x5u, embedded jwk)', async () => {
    const { verifyToken, jwks } = setup();
    const attacker = createTestKey();
    const forged = signTestToken(attacker, {
      nowSeconds: NOW,
      header: { jku: 'http://evil.test/jwks.json', x5u: 'http://evil.test/cert', jwk: attacker.publicJwk }
    });
    assert.equal(await verifyToken(forged), null);
    assert.ok(jwks.state.calls.every((call) => call.url === JWKS_URL));
  });

  test('logs contain only short reasons, never the token or its parts', async () => {
    const { verifyToken, logs, jwks } = setup();
    const t = token({ exp: NOW - 1000 });
    await verifyToken(t);
    await verifyToken(`${t.split('.')[0]}.${t.split('.')[1]}.AAAA${t.split('.')[2].slice(4)}`);
    jwks.state.mode = 'down';
    const logged = JSON.stringify(logs);
    for (const part of t.split('.')) {
      assert.ok(!logged.includes(part), 'a token part appeared in the logs');
    }
    assert.deepEqual(logs.map((entry) => entry.event), ['auth.token_rejected', 'auth.token_rejected']);
    assert.deepEqual(logs.map((entry) => entry.reason), ['expired', 'signature']);
  });

  test('refuses to start without an http(s) JWKS URL', () => {
    for (const jwksUrl of [undefined, '', 'file:///etc/keys.json', 'catalogue/.well-known/jwks.json']) {
      assert.throws(() => createJwksVerifier({ jwksUrl }));
    }
  });
});

// --- API tests with real signed tokens -------------------------------------

// The fake Timetable Service from the other tests knows users by fixed test
// strings. This wrapper plays a Timetable Service that verifies the same JWT
// (as Yehia's should) and then answers as the matching test user.
function createJwtAwareTimetableFetch(verifyToken, { mode = 'normal', subjects = {} } = {}) {
  const inner = createFakeTimetableFetch({ mode });
  const forwarded = [];
  async function fetchFn(url, options) {
    const presented = (options.headers.Authorization || '').replace('Bearer ', '');
    forwarded.push(presented);
    const user = await verifyToken(presented).catch(() => null);
    const testToken = user ? subjects[user.sub] || `test-token-${user.sub}` : 'unknown';
    return inner.fetchFn(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${testToken}` } });
  }
  return { fetchFn, forwarded, calls: inner.calls };
}

async function startRealAuthApi(t, { timetableMode, subjects } = {}) {
  const jwks = createFakeJwksServer([keyA]);
  const verifyToken = createJwksVerifier({ jwksUrl: JWKS_URL, fetchFn: jwks.fetchFn, log: () => {} });
  const timetable = createJwtAwareTimetableFetch(verifyToken, { mode: timetableMode, subjects });
  const app = createApp({
    verifyToken,
    timetableClient: createTimetableClient({ baseUrl: 'http://timetable-service.test', fetchFn: timetable.fetchFn }),
    shareStore: createFakeShareStore(),
    calendarSettings: { termStart: '2026-09-13', termEnd: '2026-12-31', timeZone: 'Africa/Cairo' },
    logError: () => {}
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, jwks, timetable };
}

function realToken(sub, role = 'student', key = keyA) {
  return signTestToken(key, { claims: { sub, role } });
}

async function call(baseUrl, method, urlPath, { bearer, body } = {}) {
  const headers = {};
  if (bearer !== undefined) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

describe('Compare & Share API with real RS256 tokens (simulated Catalogue keys)', () => {
  test('POST /api/compare works with a verified token, which is forwarded unchanged', async (t) => {
    const api = await startRealAuthApi(t);
    const jwt = realToken('student-a');
    const res = await call(api.baseUrl, 'POST', '/api/compare', { bearer: jwt, body: { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.results.length, 2);
    assert.ok(api.timetable.forwarded.every((value) => value === jwt));
  });

  test('share links: create, list, view and revoke with verified tokens', async (t) => {
    const api = await startRealAuthApi(t);
    const owner = realToken('student-a');
    const created = await call(api.baseUrl, 'POST', '/api/shares', { bearer: owner, body: { timetableId: 'tt-a', expiresInDays: 7 } });
    assert.equal(created.status, 201);
    const list = await call(api.baseUrl, 'GET', '/api/shares', { bearer: owner });
    assert.equal(list.status, 200);
    const viewer = realToken('student-b');
    const viewed = await call(api.baseUrl, 'GET', `/api/shares/${created.body.token}`, { bearer: viewer });
    assert.equal(viewed.status, 200);
    const ics = await fetch(`${api.baseUrl}/api/shares/${created.body.token}/calendar.ics`, { headers: { Authorization: `Bearer ${viewer}` } });
    assert.equal(ics.status, 200);
    const revoked = await call(api.baseUrl, 'DELETE', `/api/shares/${created.body.token}`, { bearer: owner });
    assert.equal(revoked.status, 200);
    const afterRevoke = await call(api.baseUrl, 'GET', `/api/shares/${created.body.token}`, { bearer: viewer });
    assert.notEqual(afterRevoke.status, 200);
  });

  test('another student cannot compare or share someone else\'s timetable', async (t) => {
    const api = await startRealAuthApi(t);
    const other = realToken('student-b');
    const compare = await call(api.baseUrl, 'POST', '/api/compare', { bearer: other, body: { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' } });
    assert.equal(compare.status, 404);
    const share = await call(api.baseUrl, 'POST', '/api/shares', { bearer: other, body: { timetableId: 'tt-a', expiresInDays: 7 } });
    assert.equal(share.status, 404);
  });

  test('an admin token does not bypass ownership, even if the Timetable Service wrongly returns the data', async (t) => {
    const api = await startRealAuthApi(t, { timetableMode: 'ignoresOwnership', subjects: { 'admin-1': 'test-token-student-b' } });
    const admin = realToken('admin-1', 'admin');
    const compare = await call(api.baseUrl, 'POST', '/api/compare', { bearer: admin, body: { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' } });
    assert.equal(compare.status, 404);
    assert.equal(compare.body.error.code, 'TIMETABLE_NOT_FOUND');
  });

  test('an admin cannot revoke a student\'s share link', async (t) => {
    const api = await startRealAuthApi(t);
    const created = await call(api.baseUrl, 'POST', '/api/shares', { bearer: realToken('student-a'), body: { timetableId: 'tt-a', expiresInDays: 7 } });
    const res = await call(api.baseUrl, 'DELETE', `/api/shares/${created.body.token}`, { bearer: realToken('admin-1', 'admin') });
    assert.equal(res.status, 404);
  });

  test('forged, expired and wrong-audience tokens get 401 INVALID_TOKEN and never reach the Timetable Service', async (t) => {
    const api = await startRealAuthApi(t);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const attacker = createTestKey();
    const bad = [
      signTestToken(attacker, { header: { kid: keyA.kid }, claims: { sub: 'student-a' } }),
      signTestToken(keyA, { claims: { sub: 'student-a' }, nowSeconds: nowSeconds - 3 * 3600 }),
      signTestToken(keyA, { claims: { sub: 'student-a', aud: 'other-app' } }),
      signTestToken(keyA, { claims: { sub: 'student-a' }, header: { alg: 'none' } })
    ];
    for (const jwt of bad) {
      const res = await call(api.baseUrl, 'POST', '/api/compare', { bearer: jwt, body: { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' } });
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { error: { code: 'INVALID_TOKEN', message: 'The login token is invalid or expired' } });
    }
    assert.equal(api.timetable.calls.length, 0);
  });

  test('missing token still gives 401 AUTH_REQUIRED', async (t) => {
    const api = await startRealAuthApi(t);
    const res = await call(api.baseUrl, 'GET', '/api/shares');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'AUTH_REQUIRED');
  });

  test('when the Catalogue keys cannot be loaded the API answers 503 AUTH_SERVICE_UNAVAILABLE without details', async (t) => {
    const api = await startRealAuthApi(t);
    api.jwks.state.mode = 'down';
    const res = await call(api.baseUrl, 'POST', '/api/compare', { bearer: realToken('student-a'), body: { timetableIds: ['tt-a', 'tt-b'], criterion: 'leastGaps' } });
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { error: { code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Sign-in cannot be checked right now' } });
    assert.ok(!res.text.includes('jwks'));
    assert.equal(api.timetable.calls.length, 0);
  });
});

// --- Compatibility with Mohamed's real signing code -------------------------
//
// Imports mohamed/src/auth/tokens.js read-only and gives it a temporary key
// generated here. No files are changed, no real or development key is read,
// and Mohamed's service is NOT running. This only proves that the token
// format his code produces is accepted by this verifier.

const MOHAMED_TOKENS = path.join(__dirname, '..', '..', 'mohamed', 'src', 'auth', 'tokens.js');

describe('compatibility with Mohamed\'s token signing code (no network)', { skip: !fs.existsSync(MOHAMED_TOKENS) && 'mohamed/src/auth/tokens.js not found' }, () => {
  test('tokens signed by Mohamed\'s createTokenService pass this verifier', async () => {
    const { createTokenService } = await import(pathToFileURL(MOHAMED_TOKENS).href);
    const tokens = createTokenService({
      keystore: { current: { kid: keyA.kid, privateKey: keyA.privateKey }, published: [keyA.publicJwk] },
      now: () => NOW_MS
    });
    const { verifyToken } = setup();

    const student = await verifyToken(tokens.signAccessToken({ sub: '8f14e45f-ceea-467f-a0e6-7c6e3a1b2c3d', role: 'student' }));
    assert.equal(student.sub, '8f14e45f-ceea-467f-a0e6-7c6e3a1b2c3d');
    assert.equal(student.role, 'student');
    assert.equal(student.exp, NOW + 7200);

    const admin = await verifyToken(tokens.signAccessToken({ sub: '8f14e45f-ceea-467f-a0e6-7c6e3a1b2c3d', role: 'admin' }));
    assert.equal(admin.role, 'admin');
  });

  test('this verifier and Mohamed\'s verifier agree on the clock-skew boundary', async () => {
    const { createTokenService, createTokenVerifier } = await import(pathToFileURL(MOHAMED_TOKENS).href);
    const signer = createTokenService({
      keystore: { current: { kid: keyA.kid, privateKey: keyA.privateKey }, published: [keyA.publicJwk] },
      now: () => NOW_MS
    });
    const jwt = signer.signAccessToken({ sub: 'user-1', role: 'student' });
    for (const offset of [7200 + 60, 7200 + 61]) {
      const at = NOW_MS + offset * 1000;
      const { verifyToken, clock } = setup();
      clock.ms = at;
      const mine = (await verifyToken(jwt)) !== null;
      let his = true;
      try {
        createTokenVerifier({ published: [keyA.publicJwk], now: () => at }).verifyAccessToken(jwt);
      } catch {
        his = false;
      }
      assert.equal(mine, his, `disagreement at exp + ${offset - 7200}s`);
    }
  });
});
