// TEST-ONLY helpers for JWT verification tests.
//
// RSA keys are generated fresh in memory every time the tests run. They are
// never written to disk and have nothing to do with Mohamed's real signing key.
// signTestToken() builds tokens the same way Mohamed's service does
// (RS256, header { alg, typ, kid }, claims iss/aud/sub/role/iat/exp/jti).

const crypto = require('node:crypto');

function createTestKey(modulusLength = 2048) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength });
  const jwk = publicKey.export({ format: 'jwk' });
  // Same kid rule as Mohamed's keystore: SHA-256 thumbprint of { e, kty, n }.
  const kid = crypto
    .createHash('sha256')
    .update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }))
    .digest('base64url');
  return {
    kid,
    privateKey,
    publicJwk: { kty: 'RSA', use: 'sig', alg: 'RS256', kid, n: jwk.n, e: jwk.e }
  };
}

function encodePart(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64url');
}

// Builds a signed token. header/claims entries can be overridden or removed
// (set to undefined) to create broken tokens.
function signTestToken(key, { claims = {}, header = {}, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const fullHeader = { alg: 'RS256', typ: 'JWT', kid: key.kid, ...header };
  const fullClaims = {
    iss: 'class-tt',
    aud: 'class-tt',
    sub: '11111111-2222-3333-4444-555555555555',
    role: 'student',
    iat: nowSeconds,
    exp: nowSeconds + 7200,
    jti: crypto.randomUUID(),
    ...claims
  };
  for (const name of Object.keys(fullHeader)) if (fullHeader[name] === undefined) delete fullHeader[name];
  for (const name of Object.keys(fullClaims)) if (fullClaims[name] === undefined) delete fullClaims[name];

  const signingInput = `${encodePart(fullHeader)}.${encodePart(fullClaims)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), key.privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

// A fake fetch() that serves a JWKS document. The document, status or
// behaviour can be changed between calls; every call is recorded.
function createFakeJwksServer(initialKeys = []) {
  const state = {
    keys: initialKeys.map((key) => key.publicJwk),
    status: 200,
    body: null, // raw text to send instead of the JWKS (for malformed tests)
    mode: 'normal', // 'normal' | 'down' | 'slow'
    calls: []
  };

  async function fetchFn(url, options) {
    state.calls.push({ url, options });
    if (state.mode === 'down') {
      throw new TypeError('fetch failed');
    }
    if (state.mode === 'slow') {
      // A real request keeps Node's event loop busy with its open socket. This
      // fake has no socket, so a timer stands in for it; otherwise Node 22 sees
      // an idle loop (AbortSignal.timeout does not keep it alive) and cancels
      // the test before the timeout fires.
      return new Promise((resolve, reject) => {
        const keepAlive = setInterval(() => {}, 1000);
        options.signal.addEventListener('abort', () => {
          clearInterval(keepAlive);
          reject(options.signal.reason);
        });
      });
    }
    const text = state.body !== null ? state.body : JSON.stringify({ keys: state.keys });
    return new Response(text, { status: state.status, headers: { 'Content-Type': 'application/json' } });
  }

  return {
    fetchFn,
    state,
    setKeys: (keys) => {
      state.keys = keys.map((key) => key.publicJwk);
    }
  };
}

module.exports = { createTestKey, signTestToken, createFakeJwksServer, encodePart };
