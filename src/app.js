const path = require('node:path');
const express = require('express');
const { compareTimetables, RANKING_CRITERIA } = require('./compare');
const { MIN_TIMETABLES, MAX_TIMETABLES } = require('./compareAssumptions');
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
const { registerShareRoutes } = require('./shareRoutes');
const { ShareStoreError } = require('./shareStore');
const { createRequestLogger } = require('./requestLogger');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Browser protections for the pages and the API. Scripts and styles may only
// come from this server (no inline code), so injected HTML cannot run scripts.
function setSecurityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
      "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  next();
}

// Checks the shape of the request body before anything is fetched.
function validateCompareRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return [{ code: 'INVALID_INPUT', message: 'Request body must be a JSON object' }];
  }

  const errors = [];
  const ids = body.timetableIds;
  if (!Array.isArray(ids)) {
    errors.push({ code: 'INVALID_INPUT', message: 'timetableIds must be a list' });
  } else {
    if (ids.length < MIN_TIMETABLES || ids.length > MAX_TIMETABLES) {
      errors.push({
        code: 'INVALID_TIMETABLE_COUNT',
        message: `Between ${MIN_TIMETABLES} and ${MAX_TIMETABLES} timetable ids are required`
      });
    }
    if (!ids.every(isSafeTimetableId)) {
      errors.push({ code: 'INVALID_TIMETABLE_ID', message: INVALID_ID_MESSAGE });
    } else if (new Set(ids).size !== ids.length) {
      errors.push({ code: 'DUPLICATE_TIMETABLE_ID', message: 'Each timetable id can only be included once' });
    }
  }

  if (!RANKING_CRITERIA.includes(body.criterion)) {
    errors.push({
      code: 'INVALID_CRITERION',
      message: `criterion must be one of: ${RANKING_CRITERIA.join(', ')}`
    });
  }
  return errors;
}

// Safe log entry for unexpected errors. Raw messages are not logged because
// they could contain tokens or other sensitive values. The route pattern
// (for example /api/shares/:token) is logged, never the real URL.
function buildErrorLogEntry(err, req) {
  return JSON.stringify({
    level: 'error',
    event: 'unexpected_error',
    method: req.method,
    route: req.route ? req.route.path : 'unknown',
    errorType: err instanceof Error ? err.constructor.name.slice(0, 50) : typeof err
  });
}

function createApp({
  verifyToken,
  timetableClient,
  shareStore,
  calendarSettings,
  now = () => new Date(),
  logError = console.error,
  // Written straight to stdout (not console.log) so that in Lambda each line
  // reaches CloudWatch as pure JSON, which JSON metric filters can read. The
  // Lambda console adds a "time<TAB>requestId<TAB>INFO" prefix that breaks them.
  logRequest = (line) => process.stdout.write(`${line}\n`)
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  // One safe JSON line per API request (see requestLogger.js).
  app.use(createRequestLogger({ write: logRequest }));
  app.use(setSecurityHeaders);
  // The Compare & Share pages (plain HTML, CSS and JavaScript in /public).
  app.use(express.static(PUBLIC_DIR, { dotfiles: 'ignore' }));
  app.use(express.json({ limit: '10kb' }));

  app.post('/api/compare', requireAuth(verifyToken), async (req, res) => {
    const requestErrors = validateCompareRequest(req.body);
    if (requestErrors.length > 0) {
      return sendError(res, 400, 'INVALID_REQUEST', 'The comparison request is invalid', requestErrors);
    }

    const { timetableIds, criterion } = req.body;

    // Saved timetables always come from the Timetable Service, fetched in
    // parallel with the user's own token. Timetable data sent by the browser
    // is never used.
    const fetched = await Promise.all(
      timetableIds.map((id) => timetableClient.getTimetable(id, req.token))
    );

    const failedReasons = fetched.filter((result) => !result.ok).map((result) => result.reason);
    if (failedReasons.length > 0) {
      return sendFetchError(res, failedReasons);
    }

    const timetables = fetched.map((result) => result.timetable);
    if (sendOwnershipError(res, checkOwnership(timetables, req.user))) {
      return;
    }

    // The request itself was already checked above, so any remaining problem
    // comes from the saved timetables.
    const comparison = compareTimetables(timetables, criterion);
    if (!comparison.ok) {
      return sendTimetableDataError(res, comparison.errors);
    }

    return res.status(200).json({ criterion: comparison.criterion, results: comparison.results });
  });

  registerShareRoutes(app, { verifyToken, timetableClient, shareStore, calendarSettings, now });

  app.use((req, res) => {
    sendError(res, 404, 'NOT_FOUND', 'Endpoint not found');
  });

  // Last-resort error handler. Clients never see stack traces or internal details.
  app.use((err, req, res, next) => {
    const errorType = err && err.type;
    if (errorType === 'entity.parse.failed') {
      return sendError(res, 400, 'INVALID_JSON', 'Request body is not valid JSON');
    }
    if (errorType === 'entity.too.large') {
      return sendError(res, 413, 'BODY_TOO_LARGE', 'Request body is too large');
    }
    logError(buildErrorLogEntry(err, req));
    if (err instanceof ShareStoreError) {
      return sendError(res, 503, 'SHARE_STORAGE_UNAVAILABLE', 'Share storage is not available');
    }
    return sendError(res, 500, 'INTERNAL_ERROR', 'Something went wrong');
  });

  return app;
}

module.exports = { createApp, validateCompareRequest };
