// INTEGRATION ASSUMPTIONS FOR THE COMPARE & SHARE API
//
// Item 4 (login tokens) is now CONFIRMED from Mohamed's code. Everything about
// Yehia's Timetable Service (items 1-3) is still UNCONFIRMED; it lets the API be
// built and tested before that integration. Change this file when the real
// contracts are agreed.

// 1. Yehia's endpoint for one saved timetable. Assumed:
//    GET {TIMETABLE_SERVICE_URL}/api/timetables/{id}
//    with the student's own token in "Authorization: Bearer <token>".
//    The Timetable Service is assumed to check ownership and to answer
//    404 (or 403) when the timetable is not the caller's.
function timetableUrl(baseUrl, timetableId) {
  return `${baseUrl.replace(/\/+$/, '')}/api/timetables/${encodeURIComponent(timetableId)}`;
}

// 2. Assumed 200 response body: the timetable object itself, in the shape
//    described in compareAssumptions.js. Return null if the body is not usable.
function extractTimetable(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  return body;
}

// 3. PROVISIONAL owner field on a saved timetable. Every timetable must include
//    it as a non-empty string equal to the logged-in user's "sub". If it is
//    missing or malformed the response is treated as invalid (502), and if it
//    belongs to someone else the timetable is reported as not found (404).
//    If Yehia's service uses a different ownership model, change this rule
//    with him; do not remove the check.
const OWNER_FIELD = 'ownerId';

// 4. CONFIRMED login token contract (read from Mohamed's source code at commit
//    0df8d0a: mohamed/src/auth/tokens.js, keystore.js, routes/auth.js and
//    docs/api-contract.md v1.8). This is no longer an assumption.
//    - Header "Authorization: Bearer <JWT>".
//    - Signed with RS256 only. The JWT header carries "kid" (Mohamed uses the
//      RFC 7638 thumbprint of the public key as the kid).
//    - Public keys are published at GET {catalogue}/.well-known/jwks.json as
//      { keys: [{ kty: "RSA", use: "sig", alg: "RS256", kid, n, e }] } with
//      "Cache-Control: public, max-age=600". During key rotation the old key
//      stays in the list.
//    - Claims: iss = "class-tt", aud = "class-tt" (a single string), sub = the
//      user's uuid (Mohamed's signer allows 1-64 characters), role = "student"
//      or "admin", iat, exp, jti. No email or name in the token.
//    - Lifetime: 2 hours (ACCESS_TOKEN_TTL_SECONDS, default 7200, is Mohamed's
//      setting, so it is not hard-coded here). Clock skew allowed: 60 seconds
//      for exp and iat.
//    - Callers cache the key set for 10 minutes and refetch on an unknown kid.
//    - Mohamed's own 401 code is "UNAUTHENTICATED". This service keeps its
//      existing codes (AUTH_REQUIRED, INVALID_TOKEN) so the current frontend
//      and tests keep working; aligning the codes is a separate team decision.
//    - The token's role is NOT used to grant access to other students'
//      timetables or shares. Ownership checks stay in place for everyone.
//    The verifier (jwtVerifier.js) needs CATALOGUE_JWKS_URL, for example
//    http://localhost:8080/.well-known/jwks.json on Floci. It resolves to
//    { sub, role, jti, exp } for a valid token, null for an invalid one, and
//    throws AuthUnavailableError (-> 503) when the keys cannot be loaded.
const JWT_ALGORITHM = 'RS256';
const JWT_ISSUER = 'class-tt';
const JWT_AUDIENCE = 'class-tt';
const JWT_ROLES = Object.freeze(['student', 'admin']);
const JWT_CLOCK_SKEW_SECONDS = 60;
const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
// Our own safety limits (not part of Mohamed's contract):
const JWKS_MIN_REFRESH_INTERVAL_MS = 30 * 1000; // at most one extra reload per 30 s
const JWKS_TIMEOUT_MS = 3000;

// 5. Share links. The API returns sharePath "/api/shares/{token}". The address
//    of the frontend page that will show a shared timetable is not decided yet.
//    The DynamoDB table name and region come from SHARE_TABLE_NAME and
//    AWS_REGION; the table is assumed to have partition key "token" and a GSI
//    named "ownerId-index" with partition key "ownerId" (see shareStore.js).

// 6. How long to wait for the Timetable Service before giving up.
const TIMETABLE_SERVICE_TIMEOUT_MS = 5000;

module.exports = {
  timetableUrl,
  extractTimetable,
  OWNER_FIELD,
  TIMETABLE_SERVICE_TIMEOUT_MS,
  JWT_ALGORITHM,
  JWT_ISSUER,
  JWT_AUDIENCE,
  JWT_ROLES,
  JWT_CLOCK_SKEW_SECONDS,
  JWKS_CACHE_TTL_MS,
  JWKS_MIN_REFRESH_INTERVAL_MS,
  JWKS_TIMEOUT_MS
};
