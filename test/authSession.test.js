// Tests for the browser sign-in session (public/js/authSession.mjs) and the
// refresh-and-retry behaviour of the API client (public/js/apiClient.mjs).
// SIMULATED: fetch() is faked here; these tests do not talk to Mohamed's
// service. The live browser check is reported separately.

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFakeDocument, FakeElement } = require('./fixtures/fakeDom');

const PUBLIC_JS = path.join(__dirname, '..', 'public', 'js');
const load = (file) => import(path.join(PUBLIC_JS, file).replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));

let authSession;
let apiClientModule;

before(async () => {
  authSession = await load('authSession.mjs');
  apiClientModule = await load('apiClient.mjs');
});

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// A fake of Mohamed's /api/auth/refresh plus Mohab's API, with call recording.
function fakeServer({ refreshResponses = [], apiResponder } = {}) {
  const calls = [];
  let refreshIndex = 0;
  const fetchFn = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/auth/refresh') {
      const next = refreshResponses[Math.min(refreshIndex++, refreshResponses.length - 1)];
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next();
      return next;
    }
    if (url === '/api/auth/logout') {
      return new Response(null, { status: 204 });
    }
    return apiResponder(url, options);
  };
  return { fetchFn, calls, refreshCalls: () => calls.filter((c) => c.url === '/api/auth/refresh').length };
}

function newSession(server) {
  return authSession.createAuthSession({ refreshPath: '/api/auth/refresh', logoutPath: '/api/auth/logout', fetchFn: server.fetchFn });
}

describe('auth session - restoring from the refresh cookie', () => {
  test('restore() calls POST /api/auth/refresh with same-origin cookies and keeps the token in memory', async () => {
    const server = fakeServer({ refreshResponses: [json(200, { accessToken: 'jwt-1', tokenType: 'Bearer', expiresIn: 7200 })] });
    const session = newSession(server);
    assert.equal(session.isSignedIn(), false);
    assert.equal(await session.restore(), true);
    assert.equal(session.getToken(), 'jwt-1');
    assert.equal(session.isSignedIn(), true);
    const [call] = server.calls;
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.credentials, 'same-origin');
    assert.equal(call.options.body, undefined, 'the refresh token is never sent in a body');
  });

  test('no cookie or an invalid cookie (401) means signed out', async () => {
    const server = fakeServer({ refreshResponses: [json(401, { error: { code: 'INVALID_REFRESH' } })] });
    const session = newSession(server);
    assert.equal(await session.restore(), false);
    assert.equal(session.getToken(), null);
  });

  test('a reused cookie (410 REFRESH_REUSED) means signed out', async () => {
    const server = fakeServer({ refreshResponses: [json(410, { error: { code: 'REFRESH_REUSED' } })] });
    const session = newSession(server);
    assert.equal(await session.restore(), false);
    assert.equal(session.isSignedIn(), false);
  });

  test('network errors, non-JSON bodies and missing tokens are treated as signed out', async () => {
    for (const response of [
      new TypeError('fetch failed'),
      () => new Response('<html>', { status: 200 }),
      json(200, {}),
      json(200, { accessToken: '' }),
      json(200, { accessToken: 42 })
    ]) {
      const session = newSession(fakeServer({ refreshResponses: [response] }));
      assert.equal(await session.restore(), false);
      assert.equal(session.getToken(), null);
    }
  });

  test('a failed refresh clears a token that was held before', async () => {
    const server = fakeServer({ refreshResponses: [json(200, { accessToken: 'jwt-1' }), json(401, { error: { code: 'INVALID_REFRESH' } })] });
    const session = newSession(server);
    await session.restore();
    assert.equal(await session.refresh(), false);
    assert.equal(session.getToken(), null);
  });

  test('concurrent refresh calls share one request (no extra cookie rotation)', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const server = fakeServer({ refreshResponses: [async () => { await gate; return json(200, { accessToken: 'jwt-1' }); }] });
    const session = newSession(server);
    const pending = [session.refresh(), session.refresh(), session.restore(), session.refresh()];
    release();
    assert.deepEqual(await Promise.all(pending), [true, true, true, true]);
    assert.equal(server.refreshCalls(), 1);
  });

  test('signOut() calls POST /api/auth/logout and forgets the token even if the server is down', async () => {
    const server = fakeServer({ refreshResponses: [json(200, { accessToken: 'jwt-1' })] });
    const session = newSession(server);
    await session.restore();
    await session.signOut();
    assert.equal(session.getToken(), null);
    const logout = server.calls.find((c) => c.url === '/api/auth/logout');
    assert.equal(logout.options.method, 'POST');
    assert.equal(logout.options.credentials, 'same-origin');

    const down = authSession.createAuthSession({
      refreshPath: '/api/auth/refresh',
      logoutPath: '/api/auth/logout',
      fetchFn: async (url) => {
        if (url === '/api/auth/refresh') return json(200, { accessToken: 'jwt-2' });
        throw new TypeError('fetch failed');
      }
    });
    await down.restore();
    await down.signOut();
    assert.equal(down.getToken(), null);
  });
});

describe('API client - refresh and retry with the real contract', () => {
  function client(server, session) {
    return apiClientModule.createApiClient({ getToken: session.getToken, refreshSession: session.refresh, fetchFn: server.fetchFn });
  }

  test('sends the in-memory access token in the Authorization header', async () => {
    const server = fakeServer({ refreshResponses: [json(200, { accessToken: 'jwt-1' })], apiResponder: () => json(200, { results: [] }) });
    const session = newSession(server);
    await session.restore();
    const result = await client(server, session).compare(['tt-a', 'tt-b'], 'leastGaps');
    assert.equal(result.ok, true);
    const apiCall = server.calls.find((c) => c.url === '/api/compare');
    assert.equal(apiCall.options.headers.Authorization, 'Bearer jwt-1');
  });

  test('an expired token (401 INVALID_TOKEN) is refreshed once and the request retried with the new token', async () => {
    const server = fakeServer({
      refreshResponses: [json(200, { accessToken: 'old-jwt' }), json(200, { accessToken: 'new-jwt' })],
      apiResponder: (url, options) =>
        options.headers.Authorization === 'Bearer new-jwt' ? json(200, []) : json(401, { error: { code: 'INVALID_TOKEN' } })
    });
    const session = newSession(server);
    await session.restore();
    const result = await client(server, session).listShares();
    assert.equal(result.ok, true);
    assert.equal(session.getToken(), 'new-jwt');
    const apiCalls = server.calls.filter((c) => c.url === '/api/shares');
    assert.deepEqual(apiCalls.map((c) => c.options.headers.Authorization), ['Bearer old-jwt', 'Bearer new-jwt']);
  });

  test('when refresh fails after a 401, the original error is returned and there is no second retry', async () => {
    const server = fakeServer({
      refreshResponses: [json(200, { accessToken: 'old-jwt' }), json(401, { error: { code: 'INVALID_REFRESH' } })],
      apiResponder: () => json(401, { error: { code: 'INVALID_TOKEN' } })
    });
    const session = newSession(server);
    await session.restore();
    const result = await client(server, session).listShares();
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.code, 'INVALID_TOKEN');
    assert.match(result.message, /sign in again/);
    assert.equal(server.calls.filter((c) => c.url === '/api/shares').length, 1);
    assert.equal(session.isSignedIn(), false);
  });

  test('a token that is still rejected after refresh is retried only once', async () => {
    const server = fakeServer({
      refreshResponses: [json(200, { accessToken: 'jwt-1' }), json(200, { accessToken: 'jwt-2' })],
      apiResponder: () => json(401, { error: { code: 'INVALID_TOKEN' } })
    });
    const session = newSession(server);
    await session.restore();
    const result = await client(server, session).listShares();
    assert.equal(result.status, 401);
    assert.equal(server.calls.filter((c) => c.url === '/api/shares').length, 2);
    assert.equal(server.refreshCalls(), 2);
  });

  test('several requests that all hit an expired token cause only ONE refresh', async () => {
    const server = fakeServer({
      refreshResponses: [json(200, { accessToken: 'old-jwt' }), json(200, { accessToken: 'new-jwt' })],
      apiResponder: (url, options) =>
        options.headers.Authorization === 'Bearer new-jwt' ? json(200, []) : json(401, { error: { code: 'INVALID_TOKEN' } })
    });
    const session = newSession(server);
    await session.restore();
    const api = client(server, session);
    const results = await Promise.all([api.listShares(), api.listShares(), api.getShare('A'.repeat(43)), api.listShares()]);
    assert.ok(results.every((r) => r.ok));
    assert.equal(server.refreshCalls(), 2, 'one restore at page load plus exactly one renewal');
  });

  test('with no token yet, the client tries one refresh before giving up as NOT_SIGNED_IN', async () => {
    const server = fakeServer({ refreshResponses: [json(401, { error: { code: 'INVALID_REFRESH' } })], apiResponder: () => json(200, {}) });
    const session = newSession(server);
    const result = await client(server, session).compare(['tt-a', 'tt-b'], 'leastGaps');
    assert.equal(result.code, 'NOT_SIGNED_IN');
    assert.equal(server.refreshCalls(), 1);
    assert.equal(server.calls.filter((c) => c.url === '/api/compare').length, 0, 'no protected call without a token');
  });

  test('a non-401 error is not retried', async () => {
    const server = fakeServer({ refreshResponses: [json(200, { accessToken: 'jwt-1' })], apiResponder: () => json(404, { error: { code: 'SHARE_NOT_FOUND' } }) });
    const session = newSession(server);
    await session.restore();
    const result = await client(server, session).getShare('A'.repeat(43));
    assert.equal(result.code, 'SHARE_NOT_FOUND');
    assert.equal(server.refreshCalls(), 1);
  });
});

describe('account control in the navigation', () => {
  function nav() {
    return new FakeElement('nav');
  }

  test('signed out: shows a "Sign in" link to Mohamed\'s login page', async () => {
    const session = newSession(fakeServer({ refreshResponses: [json(401, {})] }));
    await session.restore();
    const n = nav();
    const control = authSession.mountAccountControl({ doc: createFakeDocument(), nav: n, session, loginPageUrl: '/index.html', navigate: () => {} });
    assert.equal(control.tagName, 'A');
    assert.equal(control.href, '/index.html');
    assert.equal(control.textContent, 'Sign in');
    assert.equal(n.children.length, 1);
  });

  test('signed in: "Sign out" logs out on the server, then goes to the login page', async () => {
    const server = fakeServer({ refreshResponses: [json(200, { accessToken: 'jwt-1' })] });
    const session = newSession(server);
    await session.restore();
    const visited = [];
    const control = authSession.mountAccountControl({ doc: createFakeDocument(), nav: nav(), session, loginPageUrl: '/index.html', navigate: (url) => visited.push(url) });
    assert.equal(control.tagName, 'BUTTON');
    assert.equal(control.textContent, 'Sign out');
    await control.click();
    assert.equal(session.isSignedIn(), false);
    assert.ok(server.calls.some((c) => c.url === '/api/auth/logout'));
    assert.deepEqual(visited, ['/index.html']);
  });

  test('does nothing when the page has no navigation', () => {
    const session = { isSignedIn: () => false };
    assert.equal(authSession.mountAccountControl({ doc: createFakeDocument(), nav: null, session, loginPageUrl: '/index.html', navigate: () => {} }), null);
  });
});
