// One structured JSON log line per API request, written after the response is
// sent. In Lambda the line goes to CloudWatch Logs (/aws/lambda/<function>).
//
// Only safe, fixed-shape values are logged:
//   time, requestId, method, route (the route PATTERN, e.g. /api/shares/:token),
//   status, durationMs, outcome, errorCode (this service's own error codes).
// Never logged: URLs or paths, query strings, headers (Authorization, cookies),
// JWTs, share tokens, user ids, e-mail addresses, request or response bodies.

const crypto = require('node:crypto');

const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const DEPENDENCY_CODES = new Set([
  'AUTH_SERVICE_UNAVAILABLE',
  'AUTH_NOT_CONFIGURED',
  'SHARE_STORAGE_UNAVAILABLE',
  'SHARE_STORAGE_NOT_CONFIGURED',
  'TIMETABLE_SERVICE_UNAVAILABLE',
  'TIMETABLE_SERVICE_BAD_RESPONSE',
  'CALENDAR_NOT_CONFIGURED'
]);

function classify(status, errorCode) {
  if (errorCode && DEPENDENCY_CODES.has(errorCode)) return 'dependency_failure';
  if (status >= 500) return 'server_error';
  if (status === 401) return 'auth_failure';
  // 403 and 404 are both possible answers to "not yours": ownership failures are
  // reported as 404 on purpose, so they cannot be told apart from missing items.
  if (status === 403 || status === 404) return 'not_found_or_not_owner';
  if (status >= 400) return 'client_error';
  return 'ok';
}

// The route label comes from the application's own route table, never from
// the request URL, so it cannot contain tokens or other caller data.
function routeLabel(req) {
  if (req.route && typeof req.route.path === 'string') {
    return `${req.baseUrl || ''}${req.route.path}`;
  }
  return 'unmatched';
}

function createRequestLogger({ write = (line) => process.stdout.write(`${line}\n`), now = () => Date.now() } = {}) {
  return function requestLogger(req, res, next) {
    // Only the API is logged; static page and asset requests are not.
    if (!req.path.startsWith('/api/')) {
      return next();
    }
    const started = now();
    // The id comes from the Lambda runtime (set in lambda.js) or is generated
    // here. A client-supplied header is never used.
    const trusted = typeof req.lambdaRequestId === 'string' && SAFE_REQUEST_ID.test(req.lambdaRequestId) ? req.lambdaRequestId : null;
    const requestId = trusted || crypto.randomUUID();
    const method = KNOWN_METHODS.has(req.method) ? req.method : 'OTHER';

    res.on('finish', () => {
      const code = res.locals && typeof res.locals.errorCode === 'string' && SAFE_ERROR_CODE.test(res.locals.errorCode) ? res.locals.errorCode : undefined;
      const entry = {
        level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        event: 'http.request',
        time: new Date(started).toISOString(),
        requestId,
        method,
        route: routeLabel(req),
        status: res.statusCode,
        durationMs: Math.max(0, now() - started),
        outcome: classify(res.statusCode, code)
      };
      if (code) entry.errorCode = code;
      try {
        write(JSON.stringify(entry));
      } catch {
        // Logging must never break a request.
      }
    });
    next();
  };
}

module.exports = { createRequestLogger, classify, routeLabel };
