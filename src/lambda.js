// AWS Lambda entry point (handler "src/lambda.handler").
//
// It runs the SAME Express app as the local server, built by appFromEnv.js, so
// JWT verification, ownership checks, comparison, sharing and calendar export
// are unchanged. serverless-http turns an API Gateway / Lambda HTTP event into
// a normal Express request and the Express response back into a Lambda result.
//
// The app is built once per Lambda container (on the first request) and reused
// by later requests, so the JWKS key cache and the DynamoDB client are shared.
// If the configuration is invalid the app is never built: every request fails
// (fail closed) and no protected endpoint runs without verification.

const serverless = require('serverless-http');
const { buildAppFromEnv } = require('./appFromEnv');

let cachedHandler = null;

function createHandler({ buildApp = () => buildAppFromEnv(process.env) } = {}) {
  return async function handler(event, context) {
    if (!cachedHandler) {
      // Throws a ConfigError if settings are missing; Lambda then reports an
      // error for this invocation and tries again on the next one.
      cachedHandler = serverless(buildApp(), {
        // Pass the Lambda runtime's own request id to the request logger. The
        // client's "x-request-id" header is never trusted for logging.
        request(req, _event, ctx) {
          req.lambdaRequestId = ctx && typeof ctx.awsRequestId === 'string' ? ctx.awsRequestId : undefined;
        }
      });
    }
    return cachedHandler(event, context);
  };
}

// Used only by tests, so each test can start from a fresh, unbuilt handler.
function resetForTests() {
  cachedHandler = null;
}

module.exports = { handler: createHandler(), createHandler, resetForTests };
