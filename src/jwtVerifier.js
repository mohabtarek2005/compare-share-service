// Verifies the login tokens (JWTs) issued by Mohamed's Catalogue & Accounts
// service, using only the PUBLIC keys it publishes at /.well-known/jwks.json.
//
// A JWT is three base64url parts joined by dots: header.payload.signature.
// The signature is RSA-SHA256 (RS256) over "header.payload". This service can
// check that signature but can never create a token, because it never has the
// private key.
//
// The rules below follow Mohamed's own verifier (mohamed/src/auth/tokens.js),
// which is the authority for the contract. See integrationAssumptions.js.
//
// verifyToken(token) has three possible outcomes:
//   - resolves to { sub, role, jti, exp }  -> the token is valid
//   - resolves to null                      -> the token is invalid (401)
//   - throws AuthUnavailableError           -> the keys could not be loaded,
//                                              so nothing can be verified (503)
// It never logs the token itself or any key material.

const crypto = require('node:crypto');
const {
  JWT_ALGORITHM,
  JWT_ISSUER,
  JWT_AUDIENCE,
  JWT_ROLES,
  JWT_CLOCK_SKEW_SECONDS,
  JWKS_CACHE_TTL_MS,
  JWKS_MIN_REFRESH_INTERVAL_MS,
  JWKS_TIMEOUT_MS
} = require('./integrationAssumptions');

const MAX_TOKEN_LENGTH = 4096;
const MIN_TOKEN_LENGTH = 20;
const MAX_KID_LENGTH = 256;
const MAX_SUB_LENGTH = 64;
const MAX_JTI_LENGTH = 128;
const MAX_JWKS_BYTES = 100 * 1024;
const MAX_JWKS_KEYS = 20;
const MIN_RSA_BITS = 2048;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
// Printable characters only: no spaces, no control characters.
const SAFE_CLAIM = /^[\x21-\x7E]+$/;

// Thrown when verification cannot be completed at all (keys unreachable or
// unusable). The message is generic on purpose; the reason is for logs only.
class AuthUnavailableError extends Error {
  constructor(reason) {
    super('Authentication service unavailable');
    this.name = 'AuthUnavailableError';
    this.authUnavailable = true;
    this.reason = reason;
  }
}

function decodeJsonPart(part) {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSafeString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && SAFE_CLAIM.test(value);
}

// Turns a JWKS document into a Map of kid -> public key. Entries that are not
// RS256 signing keys of at least 2048 bits are skipped. Returns null if the
// document itself is not a usable JWKS.
function parseJwks(document) {
  if (!document || typeof document !== 'object' || !Array.isArray(document.keys)) {
    return null;
  }
  if (document.keys.length > MAX_JWKS_KEYS) {
    return null;
  }

  const keys = new Map();
  for (const entry of document.keys) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.kty !== 'RSA') continue;
    if (!isSafeString(entry.kid, MAX_KID_LENGTH)) continue;
    if (entry.alg !== undefined && entry.alg !== JWT_ALGORITHM) continue;
    if (entry.use !== undefined && entry.use !== 'sig') continue;
    if (typeof entry.n !== 'string' || typeof entry.e !== 'string') continue;
    if (!BASE64URL.test(entry.n) || !BASE64URL.test(entry.e)) continue;

    try {
      // Only the public parts are used, even if a JWKS wrongly included more.
      const key = crypto.createPublicKey({ key: { kty: 'RSA', n: entry.n, e: entry.e }, format: 'jwk' });
      const bits = key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength;
      if (!bits || bits < MIN_RSA_BITS) continue;
      if (!keys.has(entry.kid)) {
        keys.set(entry.kid, key);
      }
    } catch {
      // Not a valid RSA public key: skip it.
    }
  }

  return keys.size > 0 ? keys : null;
}

function defaultLog(entry) {
  console.warn(JSON.stringify({ level: 'warn', ...entry }));
}

// Builds verifyToken(token).
// jwksUrl comes ONLY from server configuration (CATALOGUE_JWKS_URL). Any key
// location inside a token ("jku", "x5u", "jwk" headers) is ignored.
function createJwksVerifier({
  jwksUrl,
  issuer = JWT_ISSUER,
  audience = JWT_AUDIENCE,
  clockSkewSeconds = JWT_CLOCK_SKEW_SECONDS,
  cacheTtlMs = JWKS_CACHE_TTL_MS,
  minRefreshIntervalMs = JWKS_MIN_REFRESH_INTERVAL_MS,
  timeoutMs = JWKS_TIMEOUT_MS,
  fetchFn = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  log = defaultLog
} = {}) {
  if (typeof jwksUrl !== 'string' || !/^https?:\/\//i.test(jwksUrl)) {
    throw new Error('createJwksVerifier needs an http(s) jwksUrl');
  }

  let cachedKeys = null; // Map of kid -> KeyObject
  let cachedAt = 0; // when the keys were last loaded successfully
  let lastAttemptAt = -Infinity; // when a load was last attempted (success or not)
  let inFlight = null; // a load that is already running, shared by callers
  let lastLoadFailed = false;

  async function loadKeys() {
    lastAttemptAt = now();
    let response;
    try {
      response = await fetchFn(jwksUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      const reason = err && err.name === 'TimeoutError' ? 'jwks_timeout' : 'jwks_unreachable';
      throw new AuthUnavailableError(reason);
    }

    if (!response || !response.ok) {
      throw new AuthUnavailableError('jwks_bad_status');
    }

    let text;
    try {
      text = await response.text();
    } catch {
      throw new AuthUnavailableError('jwks_unreadable');
    }
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_JWKS_BYTES) {
      throw new AuthUnavailableError('jwks_too_large');
    }

    let document;
    try {
      document = JSON.parse(text);
    } catch {
      throw new AuthUnavailableError('jwks_not_json');
    }

    const keys = parseJwks(document);
    if (!keys) {
      throw new AuthUnavailableError('jwks_no_usable_keys');
    }

    cachedKeys = keys;
    cachedAt = now();
    return keys;
  }

  // Runs at most one load at a time; concurrent callers share it.
  function refreshKeys() {
    if (!inFlight) {
      inFlight = loadKeys()
        .then((keys) => {
          lastLoadFailed = false;
          return keys;
        })
        .catch((err) => {
          lastLoadFailed = true;
          log({ event: 'auth.jwks_load_failed', reason: err.reason || 'unknown' });
          throw err;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  // Returns the key for kid, or null if it is not published.
  // Throws AuthUnavailableError if no fresh keys can be obtained.
  async function getKey(kid) {
    const fresh = cachedKeys !== null && now() - cachedAt < cacheTtlMs;

    if (!fresh) {
      // Expired or never loaded: must reload. Fail closed if that fails.
      // After a failed load, wait minRefreshIntervalMs before trying again,
      // so an outage does not turn every request into a new network call.
      if (!inFlight && lastLoadFailed && now() - lastAttemptAt < minRefreshIntervalMs) {
        throw new AuthUnavailableError('jwks_retry_wait');
      }
      const keys = await refreshKeys();
      return keys.get(kid) || null;
    }

    if (cachedKeys.has(kid)) {
      return cachedKeys.get(kid);
    }

    // Unknown kid with a fresh cache: maybe Mohamed rotated his key. Reload,
    // but at most once per minRefreshIntervalMs, so a stream of made-up kids
    // cannot make this service hammer the Catalogue Service.
    if (now() - lastAttemptAt < minRefreshIntervalMs) {
      return null;
    }
    try {
      const keys = await refreshKeys();
      return keys.get(kid) || null;
    } catch {
      // The keys we still hold are fresh, so this token simply is not ours.
      return null;
    }
  }

  function reject(reason) {
    log({ event: 'auth.token_rejected', reason });
    return null;
  }

  async function verifyToken(token) {
    if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
      return reject('shape');
    }

    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((part) => BASE64URL.test(part))) {
      return reject('shape');
    }
    const [headerPart, payloadPart, signaturePart] = parts;

    const header = decodeJsonPart(headerPart);
    if (!header) return reject('header');

    // The token's own "alg" is only compared with the one algorithm we accept;
    // it never chooses how to verify. This blocks "alg: none" and HS256 tricks.
    if (header.alg !== JWT_ALGORITHM) return reject('alg');
    if (header.typ !== undefined && header.typ !== 'JWT') return reject('typ');
    if (header.crit !== undefined) return reject('crit');
    if (!isSafeString(header.kid, MAX_KID_LENGTH)) return reject('kid');

    const key = await getKey(header.kid);
    if (!key) return reject('unknown_kid');

    let signatureValid = false;
    try {
      signatureValid = crypto.verify(
        'RSA-SHA256',
        Buffer.from(`${headerPart}.${payloadPart}`),
        key,
        Buffer.from(signaturePart, 'base64url')
      );
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) return reject('signature');

    const claims = decodeJsonPart(payloadPart);
    if (!claims) return reject('payload');

    if (claims.iss !== issuer) return reject('iss');
    // Mohamed's contract fixes "aud" to one string; an array is not accepted.
    if (claims.aud !== audience) return reject('aud');

    const nowSeconds = now() / 1000;
    if (!isFiniteNumber(claims.exp)) return reject('exp_type');
    if (nowSeconds > claims.exp + clockSkewSeconds) return reject('expired');
    if (!isFiniteNumber(claims.iat)) return reject('iat_type');
    if (claims.iat > nowSeconds + clockSkewSeconds) return reject('iat_future');
    // Mohamed does not issue "nbf", but if one is present it must be respected.
    if (claims.nbf !== undefined) {
      if (!isFiniteNumber(claims.nbf)) return reject('nbf_type');
      if (claims.nbf > nowSeconds + clockSkewSeconds) return reject('not_yet_valid');
    }

    if (!isSafeString(claims.sub, MAX_SUB_LENGTH)) return reject('sub');
    if (!JWT_ROLES.includes(claims.role)) return reject('role');
    if (!isSafeString(claims.jti, MAX_JTI_LENGTH)) return reject('jti');

    return Object.freeze({ sub: claims.sub, role: claims.role, jti: claims.jti, exp: claims.exp });
  }

  return verifyToken;
}

module.exports = { createJwksVerifier, AuthUnavailableError, parseJwks };
