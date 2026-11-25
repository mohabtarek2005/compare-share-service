// Helpers shared by the Compare and Share endpoints for checking timetable ids
// and the results of fetching saved timetables from the Timetable Service.
const { OWNER_FIELD } = require('./integrationAssumptions');
const { sendError } = require('./errors');

const MAX_ID_LENGTH = 100;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

const INVALID_ID_MESSAGE =
  `Timetable ids must be non-empty strings of at most ${MAX_ID_LENGTH} characters, ` +
  'without surrounding spaces or control characters, and not "." or ".."';

// Ids are kept flexible so they do not clash with Yehia's future id format.
// Only values that could change the upstream URL or hide characters are refused:
// "." and ".." (a URL would treat them as "this folder" / "parent folder"),
// leading or trailing spaces, and control characters.
function isSafeTimetableId(id) {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= MAX_ID_LENGTH &&
    id === id.trim() &&
    id !== '.' &&
    id !== '..' &&
    !CONTROL_CHARACTERS.test(id)
  );
}

function sendBadUpstreamResponse(res) {
  return sendError(res, 502, 'TIMETABLE_SERVICE_BAD_RESPONSE', 'The Timetable Service sent an invalid response');
}

function sendTimetableNotFound(res) {
  return sendError(res, 404, 'TIMETABLE_NOT_FOUND', 'One or more timetables were not found');
}

// Turns a failed fetch into an HTTP error. The order matters: a token problem
// is reported before a missing timetable, which is reported before outages.
function sendFetchError(res, failedReasons) {
  if (failedReasons.includes('UNAUTHORIZED')) {
    return sendError(res, 401, 'INVALID_TOKEN', 'The Timetable Service rejected the login token');
  }
  if (failedReasons.includes('NOT_FOUND')) {
    return sendTimetableNotFound(res);
  }
  if (failedReasons.includes('UNAVAILABLE')) {
    return sendError(res, 503, 'TIMETABLE_SERVICE_UNAVAILABLE', 'The Timetable Service is not available');
  }
  return sendBadUpstreamResponse(res);
}

// See integrationAssumptions.js (item 3): every timetable must carry the
// owner's id. A missing or malformed owner is treated as a bad upstream
// response, and a different owner as "not found", so nothing is ever used
// without a positive ownership match.
function checkOwnership(timetables, user) {
  for (const timetable of timetables) {
    const ownerId = timetable[OWNER_FIELD];
    if (typeof ownerId !== 'string' || ownerId === '') {
      return 'BAD_RESPONSE';
    }
    if (ownerId !== user.sub) {
      return 'NOT_OWNER';
    }
  }
  return 'OK';
}

// Sends the right error for a failed ownership check. Returns true if it did.
function sendOwnershipError(res, ownership) {
  if (ownership === 'BAD_RESPONSE') {
    sendBadUpstreamResponse(res);
    return true;
  }
  if (ownership === 'NOT_OWNER') {
    sendTimetableNotFound(res);
    return true;
  }
  return false;
}

// Only a genuinely stale timetable is 409. Any other problem with a saved
// timetable means the Timetable Service sent bad data (502). Upstream details
// are not passed back to the client.
function sendTimetableDataError(res, errors) {
  const onlyStale = errors.every((error) => error.code === 'STALE_TIMETABLE');
  if (onlyStale) {
    const details = errors.map((error) => ({ code: error.code, timetableId: error.timetableId }));
    return sendError(res, 409, 'STALE_TIMETABLE', 'One or more timetables are outdated', details);
  }
  return sendBadUpstreamResponse(res);
}

module.exports = {
  MAX_ID_LENGTH,
  INVALID_ID_MESSAGE,
  isSafeTimetableId,
  sendFetchError,
  checkOwnership,
  sendOwnershipError,
  sendTimetableDataError
};
