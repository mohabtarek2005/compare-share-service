# Compare & Share on AWS Lambda (local Floci)

The service runs the same Express app in two ways:

- **Local server:** `node src/server.js` (unchanged).
- **AWS Lambda:** handler `src/lambda.handler`, which wraps the app with
  [`serverless-http`](https://github.com/dougmoscrop/serverless-http).

Both build the app with `src/appFromEnv.js`, so JWT verification, ownership
checks, comparison, sharing and calendar export behave the same.

## Build the package

```bash
node scripts/package-lambda.js            # writes D:/Downloadss/class-tt-local-test/lambda/compare-share-lambda.zip
```

The ZIP holds `src/`, `public/`, `package.json`, `package-lock.json` and the
production `node_modules`. Tests, test fixtures, `.env` files and keys are never
packaged (the script stops if it finds one), and the ZIP is written outside the
Git repository.

## Deploy to Floci

```bash
bash scripts/deploy-floci-lambda.sh
```

The script only accepts a local endpoint (`http://127.0.0.1:4566` by default),
always uses Floci's dummy `test` credentials, and stops unless the account is
`000000000000`, so it cannot reach real AWS. It creates (or updates):

| Item | Value |
|---|---|
| Function | `class-tt-compare-share`, `nodejs22.x`, handler `src/lambda.handler`, 256 MB, 15 s |
| Role | `class-tt-compare-share-lambda` with `deploy/lambda-permissions-policy.json` |
| Permissions | `GetItem`/`PutItem`/`UpdateItem` on `share_links`, `Query` on its `ownerId-index`, own log group only |

## Function settings (environment variables)

| Variable | Default in the script | Why |
|---|---|---|
| `SHARE_TABLE_NAME` | `share_links` | DynamoDB table |
| `DYNAMODB_ENDPOINT` | `http://floci:4566` | Floci by its Docker name (inside Lambda, `localhost` is the container) |
| `CATALOGUE_JWKS_URL` | `http://host.docker.internal:3000/.well-known/jwks.json` | Mohamed's public keys on the PC |
| `TIMETABLE_SERVICE_URL` | `http://host.docker.internal:3002` | Yehia's Timetable Service (confirmed contract, see below) |
| `TERM_START_DATE`, `TERM_END_DATE`, `TIMEZONE` | `2026-09-13`, `2026-12-31`, `Africa/Cairo` | calendar export |

`AWS_REGION` is set by the Lambda runtime itself. No Function URL is created.

## API Gateway (HTTP API v2)

```bash
bash scripts/deploy-floci-apigateway.sh      # after deploy-floci-lambda.sh
```

Same safety guard as the Lambda script (local endpoint only, dummy
credentials, account `000000000000`). Re-running reuses everything by name, so
it never creates duplicates, and it never deletes anything. It sets up:

| Item | Value |
|---|---|
| API | `class-tt-compare-share-api`, protocol HTTP, no CORS (pages are served same-origin) |
| Integration | `AWS_PROXY` to `class-tt-compare-share`, payload format `2.0`, 15 s timeout |
| Routes | `POST /api/compare`, `POST /api/shares`, `GET /api/shares`, `GET /api/shares/{token}`, `DELETE /api/shares/{token}`, `GET /api/shares/{token}/calendar.ics` |
| Stage | `$default`, auto-deploy (no stage name in the URL path) |
| Permission | `lambda:InvokeFunction` for `apigateway.amazonaws.com`, source `arn:aws:execute-api:us-east-1:000000000000:<apiId>/*/*/api/*` |

Only these six routes reach the function; anything else gets API Gateway's own
`{"message":"Not Found"}`. Login (JWT) and ownership checks stay inside the
application: API Gateway is not used as a security boundary.

The script prints the URL, for example:

```bash
API_URL=http://<apiId>.execute-api.localhost.floci.io:4566
curl -i "$API_URL/api/shares"                                  # 401 AUTH_REQUIRED
curl -i -H "Authorization: Bearer <access token>" "$API_URL/api/shares"
```

`*.localhost.floci.io` resolves to this computer (127.0.0.1 / ::1). Floci only
listens on 127.0.0.1, so tools that try IPv6 first may need
`curl --resolve <apiId>.execute-api.localhost.floci.io:4566:127.0.0.1 ...`.

## CloudWatch logging and monitoring

```bash
bash scripts/deploy-floci-monitoring.sh      # after the Lambda is deployed
```

**Logs.** Lambda output goes to the log group `/aws/lambda/class-tt-compare-share`
(retention set to 14 days). Every API request writes one JSON line
(`src/requestLogger.js`):

```json
{"level":"warn","event":"http.request","time":"2026-11-24T21:35:02.120Z","requestId":"<Lambda request id>",
 "method":"GET","route":"/api/shares/:token","status":404,"durationMs":12,
 "outcome":"not_found_or_not_owner","errorCode":"SHARE_NOT_FOUND"}
```

- `route` is the route **pattern**, so share tokens never appear; requests that
  fail before routing (for example broken JSON) are labelled `unmatched`.
- `requestId` comes from the Lambda runtime; a client `x-request-id` header is
  never used. `method` is one of the standard HTTP methods or `OTHER`.
- `outcome` is `ok`, `client_error`, `auth_failure`, `not_found_or_not_owner`
  (ownership failures are deliberately reported as 404), `dependency_failure`
  or `server_error`.
- Never logged: URLs, query strings, headers (Authorization, cookies), JWTs,
  share tokens, user ids, e-mail addresses, request or response bodies, keys.
- The existing lines stay: `auth.token_rejected` (reason only),
  `auth.jwks_load_failed` and `unexpected_error` (error type and route only).
- The request line is written straight to stdout so it reaches CloudWatch as
  pure JSON; lines written with `console.*` get a `time<TAB>requestId<TAB>LEVEL`
  prefix from the Lambda runtime, which JSON metric filters cannot read.

**Metrics** (log-based, namespace `ClassTT/CompareShare`):

| Metric | Filter |
|---|---|
| `Requests` | `{ $.event = "http.request" }` |
| `ServerErrors` | `{ $.event = "http.request" && $.status >= 500 }` |
| `AuthFailures` | `{ $.event = "http.request" && $.status = 401 }` |
| `DependencyFailures` | `{ $.event = "http.request" && $.outcome = "dependency_failure" }` |
| `LatencyMs` | value `$.durationMs` of every request line |
| `LambdaInvocationErrors` | `"Invoke Error"` (the function itself failed; kept apart from HTTP 5xx answers) |

**Alarms** (no notification target yet):

| Alarm | Rule |
|---|---|
| `class-tt-compare-share-5xx` | `ServerErrors` sum ≥ 1 in 60 s |
| `class-tt-compare-share-auth-failures` | `AuthFailures` sum ≥ 5 in 300 s (possible token guessing) |
| `class-tt-compare-share-invocation-errors` | `LambdaInvocationErrors` sum ≥ 1 in 60 s |

Useful commands (Git Bash; `MSYS_NO_PATHCONV=1` stops Git Bash rewriting `/aws/...`):

```bash
export MSYS_NO_PATHCONV=1 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test; unset AWS_PROFILE
E="--endpoint-url http://127.0.0.1:4566 --region us-east-1 --no-cli-pager"
aws $E logs filter-log-events --log-group-name /aws/lambda/class-tt-compare-share --filter-pattern '{ $.event = "http.request" }' < /dev/null
aws $E cloudwatch get-metric-statistics --namespace ClassTT/CompareShare --metric-name AuthFailures \
  --start-time 2026-11-24T21:00:00Z --end-time 2026-11-24T22:00:00Z --period 60 --statistics Sum < /dev/null
aws $E cloudwatch describe-alarms --alarm-name-prefix class-tt-compare-share --query 'MetricAlarms[].[AlarmName,StateValue]' < /dev/null
aws $E cloudwatch describe-alarm-history --alarm-name class-tt-compare-share-5xx --history-item-type StateUpdate < /dev/null
```

## Timetable Service integration (Yehia)

**Confirmed contract.** Verified live against Yehia's Timetable Service
(`DEP_MODE=live`, commits `01c6397`/`26b11b5`) using Mohamed's real Catalogue and
logins. `GET /api/timetables/{id}` returns:

```json
{ "id": "…", "ownerId": "<token sub>", "name": "…", "createdAt": "…", "sectionIds": ["…"],
  "sections": [ { "id": "…", "courseId": "…", "courseCode": "TST401", "courseTitle": "…",
                  "sectionCode": "L2", "type": "lecture", "status": "ACTIVE",
                  "times": [ { "day": "Sun", "start": "12:00", "end": "13:00", "room": "T-105" },
                             { "day": "Tue", "start": "09:00", "end": "10:00", "room": "T-105" } ] } ],
  "missingSectionIds": [], "archivedSectionIds": [], "stale": false }
```

`GET /api/timetables` lists the caller's timetables
(`[{ id, ownerId, name, createdAt, sectionIds, stale }]`); the frontend uses it
for the timetable picker (`appConfig.timetableListPath`).

**Adapter** (`normalizeTimetable` in `src/integrationAssumptions.js`):

| Yehia | Compare & Share |
|---|---|
| `section.id` | `sectionId` |
| `section.courseCode` | `courseCode` |
| `section.type` | `type` (missing → 502; never inferred) |
| `section.times[]` | `meetings[]` (every meeting kept) |
| `day` `Sun`…`Sat` (any case) | `SUN`…`SAT`; any other value → 502 |
| `start` / `end` | `startTime` / `endTime` (HH:MM checked by the comparison) |
| `stale`, `missingSectionIds`, `archivedSectionIds`, `status !== "ACTIVE"` | outdated → **409** `STALE_TIMETABLE` |
| `ownerId` | must equal the token's `sub` (missing → 502, other owner → 404) |
| anything else malformed or unexpected | **502** `TIMETABLE_SERVICE_BAD_RESPONSE` |

**Teaching week:** all seven days (team decision of 25 Nov 2026, matching
Mohamed's `dayOfWeek` 0–6 and Yehia's 7-day support in `26b11b5`). Free days are
counted over Sunday–Saturday, and Friday/Saturday classes are compared, shared
and exported to `.ics` like any other day.

**Configuration.** The Lambda reaches Yehia with
`TIMETABLE_SERVICE_URL=http://host.docker.internal:3002` (his service on the PC,
started with `DEP_MODE=live`, `CATALOGUE_URL=http://127.0.0.1:3000`,
`JWT_ISSUER=class-tt`, `JWT_AUDIENCE=class-tt` and Floci for DynamoDB). The local
"deployed" preview proxy sends `GET /api/timetables` to Yehia and the Compare &
Share API to API Gateway, on one origin with Mohamed's login.

**End-to-end results (25 Nov 2026, real services only):** 30/30 checks — login,
Catalogue, generate and save in Yehia's service, saved-timetable list, compare of
4 real timetables (one with a Friday class) with all four metrics and rankings
equal to hand calculations, share via API Gateway + Lambda, view by another user
(5 meetings, types kept), ICS with the right weekdays/times and weekly
recurrence (including a Friday event), owner revoke, 404 for another user's
compare/share/revoke, 401 without a token, 409 for a timetable whose section was
archived, normalized snapshot in DynamoDB, one CloudWatch line per request with
no sensitive values (metrics equal the log lines). Browser check on the deployed
preview: real list, compare and share all worked.

**Known limitations (other teams):**
- Yehia's README still describes a Sunday–Thursday grid; his code supports 7 days.
- Yehia defaults a missing section `type` to `"lecture"` (Mohamed always sends one).
- Yehia's JWKS cooldown (30 s) only starts after a successful key download, so
  repeated failures still call the Catalogue each time; clock tolerance is 60 s.
- Missing sections cannot be produced with the real Catalogue (sections are
  archived, never deleted), so "missing" was only tested with fixtures.

## Floci 2.5.0 limitations (checked)

- **No built-in Lambda or API Gateway metrics:** `AWS/Lambda` (Invocations,
  Errors, Duration) and `AWS/ApiGateway` are empty after real invocations, and
  Floci writes no START/END/REPORT lines. Monitoring therefore uses log-based
  metrics from the application's own request lines.
- Log-based metrics and single-metric alarms work: metric values matched the
  logged requests exactly, and alarms moved OK → ALARM after errors and back to
  OK after a quiet minute (alarm history). Floci keeps metrics in memory.
- Logs Insights supports only `fields`, `filter`, `sort`, `dedup` and `limit`
  (no `stats`), so `filter-log-events` and metric filters are used instead.

- **IAM is not enforced for Lambda's role:** removing `dynamodb:Query` from the
  role's policy did not stop the function (tested). The least-privilege policy
  is correct for real AWS but is not proven by the emulator.
- **Lambda invoke permissions are not checked for HTTP APIs** (Floci docs), and
  `execute-api` IAM/resource policies are not evaluated.
- Integration `credentials` are stored but not used (Floci docs).
- The first request after a deployment or settings change starts a new Lambda
  container and can take tens of seconds; the very first run also downloads the
  `public.ecr.aws/lambda/nodejs:22` image (about 600 MB on disk).
- On this Windows setup the AWS CLI must run with stdin closed and
  `--no-cli-pager`, otherwise it waits after printing; the scripts do this.

## Tests on Node.js 22

The Lambda runtime is Node 22. The full suite can be run in the same image
without installing Node 22 on the PC (files mounted read-only, no network):

```bash
MSYS_NO_PATHCONV=1 docker run --rm --network none --entrypoint node \
  -v "D:/Downloadss/cloud-security-team-38:/repo:ro" -w /repo/mohab \
  public.ecr.aws/lambda/nodejs:22 --test "test/**/*.test.js"
```
