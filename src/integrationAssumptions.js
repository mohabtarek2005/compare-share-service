// INTEGRATION CONTRACTS FOR THE COMPARE & SHARE API
//
// Both are CONFIRMED from the real services:
//   items 1-3: Yehia's Timetable Service, commit 01c6397 (main 2fe5f2b), tested
//              live in DEP_MODE=live against Mohamed's Catalogue;
//   item 4:    Mohamed's login tokens.

// 1. One saved timetable:
//    GET {TIMETABLE_SERVICE_URL}/api/timetables/{id}
//    with the student's own token in "Authorization: Bearer <token>".
//    Yehia stores timetables under the token's "sub" and answers 404 when the
//    timetable is not the caller's.
function timetableUrl(baseUrl, timetableId) {
  return `${baseUrl.replace(/\/+$/, '')}/api/timetables/${encodeURIComponent(timetableId)}`;
}

// 2. CONFIRMED 200 response body (Yehia 01c6397):
//    {
//      id, ownerId, name, createdAt, sectionIds,
//      sections: [{
//        id, courseId, courseCode, courseTitle, sectionCode,
//        type,                         // "lecture" | "lab" | "tutorial" (from the Catalogue)
//        status,                       // "ACTIVE" | "ARCHIVED"
//        times: [{ day: "Sun", start: "09:00", end: "10:30", room }]   // every meeting
//      }],
//      missingSectionIds: [], archivedSectionIds: [], stale: false
//    }
//
//    normalizeTimetable() turns it into the internal shape used by the
//    comparison, sharing and calendar code (see compareAssumptions.js):
//      section.id         -> sectionId
//      section.courseCode -> courseCode
//      section.type       -> type        (never inferred when missing)
//      section.times[]    -> meetings[]  (every meeting kept)
//      time.day  Sun..Sat -> SUN..SAT    (all seven days, case-insensitive;
//                                         any other value is invalid -> 502)
//      time.start/end     -> startTime/endTime
//    A timetable is marked stale (409 later) when Yehia says stale, or lists
//    missing or archived sections, or any section is not ACTIVE.
//
//    Result:
//      { ok: false }            malformed or unexpected -> 502
//      { ok: true, timetable }
const DAY_NAMES = { sun: 'SUN', mon: 'MON', tue: 'TUE', wed: 'WED', thu: 'THU', fri: 'FRI', sat: 'SAT' };
const ACTIVE_STATUS = 'ACTIVE';

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isTextList = (value) => Array.isArray(value) && value.every(isText);

function normalizeMeeting(time) {
  if (!isObject(time) || typeof time.day !== 'string' || typeof time.start !== 'string' || typeof time.end !== 'string') {
    return null;
  }
  const day = DAY_NAMES[time.day.trim().toLowerCase()];
  if (!day) {
    return null;
  }
  // Time format is checked later by the comparison code (HH:MM).
  return { day, startTime: time.start, endTime: time.end };
}

function normalizeSection(section) {
  if (!isObject(section) || !isText(section.id) || !isText(section.courseCode) || !isText(section.type)) {
    return null;
  }
  if (section.status !== undefined && typeof section.status !== 'string') {
    return null;
  }
  if (!Array.isArray(section.times) || section.times.length === 0) {
    return null;
  }
  const meetings = [];
  for (const time of section.times) {
    const meeting = normalizeMeeting(time);
    if (!meeting) {
      return null; // one bad meeting makes the whole response unusable; nothing is dropped
    }
    meetings.push(meeting);
  }
  return {
    normalized: { sectionId: section.id, courseCode: section.courseCode, type: section.type, meetings },
    inactive: section.status !== undefined && section.status.trim().toUpperCase() !== ACTIVE_STATUS
  };
}

function normalizeTimetable(body) {
  if (!isObject(body) || !Array.isArray(body.sections)) {
    return { ok: false };
  }
  if (body.stale !== undefined && typeof body.stale !== 'boolean') return { ok: false };
  if (body.missingSectionIds !== undefined && !isTextList(body.missingSectionIds)) return { ok: false };
  if (body.archivedSectionIds !== undefined && !isTextList(body.archivedSectionIds)) return { ok: false };

  const sections = [];
  let anyInactive = false;
  for (const section of body.sections) {
    const result = normalizeSection(section);
    if (!result) {
      return { ok: false };
    }
    anyInactive = anyInactive || result.inactive;
    sections.push(result.normalized);
  }

  const archived = Array.isArray(body.archivedSectionIds) && body.archivedSectionIds.length > 0;
  const timetable = {
    id: body.id,
    name: body.name,
    [OWNER_FIELD]: body[OWNER_FIELD],
    stale: body.stale === true || archived || anyInactive,
    missingSectionIds: body.missingSectionIds,
    sections
  };
  return { ok: true, timetable };
}

// 3. Owner field. Every timetable must include it as a non-empty string equal
//    to the logged-in user's "sub" (Yehia returns the stored owner, which is
//    the token's sub). Missing or malformed -> 502; another owner -> 404.
//    This check stays even though Yehia also scopes by owner.
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
  normalizeTimetable,
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
