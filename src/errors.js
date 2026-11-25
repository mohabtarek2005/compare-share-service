// Every API error uses the same shape:
// { "error": { "code": "SOME_CODE", "message": "Readable text", "details": [...] } }
function sendError(res, status, code, message, details) {
  const error = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  // Remembered for the request log line (requestLogger.js); codes are fixed
  // constants of this service, never caller data.
  if (res.locals) {
    res.locals.errorCode = code;
  }
  return res.status(status).json({ error });
}

module.exports = { sendError };
