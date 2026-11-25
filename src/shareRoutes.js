const crypto = require('node:crypto');
const { validateTimetable } = require('./compare');
const { requireAuth } = require('./auth');
const { sendError } = require('./errors');
const {
  INVALID_ID_MESSAGE,
  isSafeTimetableId,
  sendFetchError,
  checkOwnership,
  sendOwnershipError,
  sendTimetableDataError
} = require('./timetableAccess');
const { validateTermSettings, buildTimetableCalendar, calendarFileName } = require('./icsCalendar');

const MIN_EXPIRY_DAYS = 1;
const MAX_EXPIRY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32; // 256 random bits
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes in base64url
const MAX_TOKEN_ATTEMPTS = 3;
// DynamoDB items are limited to 400 KB. Records are kept well below that.
const MAX_RECORD_BYTES = 300 * 1024;
const TOKEN_LENGTH = 43;

// Size of the stored record in UTF-8 bytes (an Arabic letter is 2 bytes,
// so string length alone would under-count).
function recordSizeBytes(record) {
  return Buffer.byteLength(JSON.stringify({ token: 'x'.repeat(TOKEN_LENGTH), ...record }), 'utf8');
}

function generateShareToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function validateCreateShareRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return [{ code: 'INVALID_INPUT', message: 'Request body must be a JSON object' }];
  }
  const errors = [];
  if (!isSafeTimetableId(body.timetableId)) {
    errors.push({ code: 'INVALID_TIMETABLE_ID', message: INVALID_ID_MESSAGE });
  }
  const days = body.expiresInDays;
  if (!Number.isInteger(days) || days < MIN_EXPIRY_DAYS || days > MAX_EXPIRY_DAYS) {
    errors.push({
      code: 'INVALID_EXPIRY',
      message: `expiresInDays must be a whole number from ${MIN_EXPIRY_DAYS} to ${MAX_EXPIRY_DAYS}`
    });
  }
  return errors;
}

// The snapshot keeps only the fields needed to show the timetable. Owner id
// and any other upstream fields are left out, so they are never shared.
function buildSnapshot(timetable) {
  return {
    id: timetable.id,
    name: timetable.name || null,
    sections: timetable.sections.map((section) => ({
      sectionId: section.sectionId,
      courseCode: section.courseCode,
      type: section.type,
      meetings: section.meetings.map((meeting) => ({
        day: meeting.day,
        startTime: meeting.startTime,
        endTime: meeting.endTime
      }))
    }))
  };
}

function isActive(share, nowIso) {
  return !share.revokedAt && share.expiresAt > nowIso;
}

// Newest link first; links created at the same moment are ordered by token.
function newestFirst(a, b) {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  return a.token < b.token ? -1 : 1;
}

function sendShareNotFound(res) {
  // The same answer for a missing, expired, revoked or someone else's link,
  // so a caller cannot learn which tokens exist.
  return sendError(res, 404, 'SHARE_NOT_FOUND', 'This share link does not exist, has expired or was revoked');
}

function registerShareRoutes(app, { verifyToken, timetableClient, shareStore, calendarSettings, now }) {
  const auth = requireAuth(verifyToken);
  // Term dates and time zone are checked once at start-up. If they are missing
  // or invalid, only the calendar download is refused (503).
  const calendar = calendarSettings ? validateTermSettings(calendarSettings) : { ok: false };

  // Refuse share requests if no database was configured, instead of using
  // some temporary storage that would lose data.
  function requireStore(req, res, next) {
    if (!shareStore) {
      return sendError(res, 503, 'SHARE_STORAGE_NOT_CONFIGURED', 'Share storage is not available');
    }
    next();
  }

  app.post('/api/shares', auth, requireStore, async (req, res) => {
    const requestErrors = validateCreateShareRequest(req.body);
    if (requestErrors.length > 0) {
      return sendError(res, 400, 'INVALID_REQUEST', 'The share request is invalid', requestErrors);
    }
    const { timetableId, expiresInDays } = req.body;

    // The timetable always comes from the Timetable Service with the user's
    // own token. A snapshot or owner id sent by the browser is ignored.
    const fetched = await timetableClient.getTimetable(timetableId, req.token);
    if (!fetched.ok) {
      return sendFetchError(res, [fetched.reason]);
    }
    const timetable = fetched.timetable;
    if (sendOwnershipError(res, checkOwnership([timetable], req.user))) {
      return;
    }
    const timetableErrors = validateTimetable(timetable);
    if (timetableErrors.length > 0) {
      return sendTimetableDataError(res, timetableErrors);
    }

    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + expiresInDays * DAY_MS);
    const record = {
      ownerId: req.user.sub,
      timetableId,
      snapshot: buildSnapshot(timetable),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      expiresAtEpoch: Math.floor(expiresAt.getTime() / 1000)
    };

    // A timetable this large can only come from bad upstream data.
    if (recordSizeBytes(record) > MAX_RECORD_BYTES) {
      return sendError(res, 502, 'TIMETABLE_SERVICE_BAD_RESPONSE', 'The Timetable Service sent an invalid response');
    }

    // A clash between two random 256-bit tokens is practically impossible,
    // but the store never overwrites an existing token, so try again if it happens.
    for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt++) {
      const token = generateShareToken();
      const created = await shareStore.createShare({ token, ...record });
      if (created) {
        return res.status(201).json({
          token,
          timetableId,
          timetableName: record.snapshot.name,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          sharePath: `/api/shares/${token}`
        });
      }
    }
    throw new Error('Could not generate a unique share token');
  });

  app.get('/api/shares', auth, requireStore, async (req, res) => {
    const nowIso = now().toISOString();
    const shares = await shareStore.listSharesByOwner(req.user.sub);
    const active = shares
      // Checked again here in case the database returned someone else's item.
      .filter((share) => share.ownerId === req.user.sub && isActive(share, nowIso))
      .sort(newestFirst)
      .map((share) => ({
        token: share.token,
        timetableId: share.timetableId,
        timetableName: share.snapshot ? share.snapshot.name : null,
        createdAt: share.createdAt,
        expiresAt: share.expiresAt,
        sharePath: `/api/shares/${share.token}`
      }));
    return res.status(200).json({ shares: active });
  });

  // Loads an active share for the token in the URL. Any logged-in user with the
  // token may open it. Sends a 404 and returns null for a badly formed,
  // missing, expired or revoked link.
  async function loadActiveShare(req, res) {
    const { token } = req.params;
    if (!TOKEN_PATTERN.test(token)) {
      sendShareNotFound(res);
      return null;
    }
    const share = await shareStore.getShare(token);
    // Expiry is checked here on every read; DynamoDB TTL deletion can be late.
    if (!share || !isActive(share, now().toISOString())) {
      sendShareNotFound(res);
      return null;
    }
    return share;
  }

  // The calendar is built from the stored snapshot, never from live data.
  app.get('/api/shares/:token/calendar.ics', auth, requireStore, async (req, res) => {
    if (!calendar.ok) {
      return sendError(res, 503, 'CALENDAR_NOT_CONFIGURED', 'Calendar export is not available');
    }
    const share = await loadActiveShare(req, res);
    if (!share) {
      return;
    }
    const ics = buildTimetableCalendar(share.snapshot, calendar.settings, now());
    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${calendarFileName(share.snapshot)}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.status(200).send(Buffer.from(ics, 'utf8'));
  });

  app.get('/api/shares/:token', auth, requireStore, async (req, res) => {
    const share = await loadActiveShare(req, res);
    if (!share) {
      return;
    }
    // The owner id is not returned.
    return res.status(200).json({
      timetable: share.snapshot,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt
    });
  });

  app.delete('/api/shares/:token', auth, requireStore, async (req, res) => {
    const { token } = req.params;
    if (!TOKEN_PATTERN.test(token)) {
      return sendShareNotFound(res);
    }
    const revokedAt = now().toISOString();
    // Ownership, "not already revoked" and "not expired" are checked by the
    // store in the same operation that revokes the link.
    const revoked = await shareStore.revokeShare(token, req.user.sub, revokedAt);
    if (!revoked) {
      return sendShareNotFound(res);
    }
    return res.status(200).json({ token, revokedAt });
  });
}

module.exports = {
  registerShareRoutes,
  generateShareToken,
  buildSnapshot,
  recordSizeBytes,
  TOKEN_PATTERN,
  MAX_RECORD_BYTES
};
