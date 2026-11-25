const { sendError } = require('./errors');

function readBearerToken(req) {
  const header = req.get('authorization');
  if (typeof header !== 'string') {
    return null;
  }
  const match = header.match(/^Bearer ([^\s]+)$/i);
  return match ? match[1] : null;
}

// Builds the middleware that protects an endpoint.
// verifyToken is supplied by whoever starts the server: the real one is the
// JWKS verifier in jwtVerifier.js; tests inject their own. Without one, every
// protected request is refused (fail closed) instead of being let through.
//
// Responses:
//   401 AUTH_REQUIRED            no usable "Bearer <token>" header
//   401 INVALID_TOKEN            the token failed verification
//   503 AUTH_NOT_CONFIGURED      no verifier was configured
//   503 AUTH_SERVICE_UNAVAILABLE the verifier could not load the signing keys
// Any other error thrown by a verifier is treated as an invalid token (401),
// so a broken verifier can never let a request through.
function requireAuth(verifyToken) {
  return async function (req, res, next) {
    if (typeof verifyToken !== 'function') {
      return sendError(res, 503, 'AUTH_NOT_CONFIGURED', 'Authentication is not available');
    }

    const token = readBearerToken(req);
    if (!token) {
      return sendError(res, 401, 'AUTH_REQUIRED', 'A login token is required');
    }

    let user = null;
    try {
      user = await verifyToken(token);
    } catch (err) {
      if (err && err.authUnavailable === true) {
        return sendError(res, 503, 'AUTH_SERVICE_UNAVAILABLE', 'Sign-in cannot be checked right now');
      }
      user = null;
    }
    if (!user || typeof user.sub !== 'string' || user.sub === '') {
      return sendError(res, 401, 'INVALID_TOKEN', 'The login token is invalid or expired');
    }

    // Only verified values are stored. Nothing is taken from the body or other headers.
    req.user = user;
    req.token = token;
    next();
  };
}

module.exports = { requireAuth, readBearerToken };
