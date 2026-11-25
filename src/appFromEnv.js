// Builds the real Compare & Share app from environment variables.
// Shared by the local server (server.js) and the AWS Lambda handler (lambda.js),
// so both run exactly the same checks. Problems throw a ConfigError instead of
// exiting, and the caller decides what to do: the local server prints the
// message and exits, Lambda fails its start-up (fail closed).
//
// Required:
//   TIMETABLE_SERVICE_URL   Yehia's Timetable Service base URL
//   CATALOGUE_JWKS_URL      Mohamed's public keys, e.g. http://localhost:8080/.well-known/jwks.json
//   SHARE_TABLE_NAME, AWS_REGION   DynamoDB table and region (see shareStore.js)
// Optional:
//   DYNAMODB_ENDPOINT       local emulator such as Floci
//   TERM_START_DATE, TERM_END_DATE, TIMEZONE   calendar export (only that endpoint is disabled if invalid)

const { createApp } = require('./app');
const { createTimetableClient } = require('./timetableClient');
const { createShareStoreFromEnv } = require('./shareStore');
const { validateTermSettings, DEFAULT_TIME_ZONE } = require('./icsCalendar');
const { createJwksVerifier } = require('./jwtVerifier');

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function buildAppFromEnv(env = process.env, { warn = (message) => console.warn(message) } = {}) {
  const timetableServiceUrl = env.TIMETABLE_SERVICE_URL;
  if (!timetableServiceUrl) {
    throw new ConfigError('TIMETABLE_SERVICE_URL is not set. Example: TIMETABLE_SERVICE_URL=http://localhost:3002');
  }

  // Mohamed's public signing keys. Refuses to build without a valid http(s)
  // URL, so the service can never run with login checks switched off.
  const jwksUrl = (env.CATALOGUE_JWKS_URL || '').trim();
  let verifyToken;
  try {
    const parsed = new URL(jwksUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('bad url');
    }
    verifyToken = createJwksVerifier({ jwksUrl: parsed.href });
  } catch {
    throw new ConfigError(
      'CATALOGUE_JWKS_URL is missing or invalid. Example: CATALOGUE_JWKS_URL=http://localhost:8080/.well-known/jwks.json'
    );
  }

  // Refuses to build without DynamoDB settings. It never falls back to
  // in-memory storage, which would silently lose share links.
  let shareStore;
  try {
    shareStore = createShareStoreFromEnv(env);
  } catch (err) {
    throw new ConfigError(`${err.message}. Example: SHARE_TABLE_NAME=share_links AWS_REGION=us-east-1`);
  }

  // Academic term for calendar (.ics) export. Missing or invalid settings only
  // disable the calendar download; the rest of the service keeps working.
  const calendarSettings = {
    termStart: env.TERM_START_DATE,
    termEnd: env.TERM_END_DATE,
    timeZone: env.TIMEZONE || DEFAULT_TIME_ZONE
  };
  const calendarCheck = validateTermSettings(calendarSettings);
  if (!calendarCheck.ok) {
    warn(`Calendar export disabled: ${calendarCheck.error}`);
  }

  return createApp({
    verifyToken,
    timetableClient: createTimetableClient({ baseUrl: timetableServiceUrl }),
    shareStore,
    calendarSettings
  });
}

module.exports = { buildAppFromEnv, ConfigError };
