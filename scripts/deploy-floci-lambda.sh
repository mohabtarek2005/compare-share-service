#!/usr/bin/env bash
# Deploys the Compare & Share Lambda function to LOCAL Floci only.
#
#   bash scripts/deploy-floci-lambda.sh            (from the mohab folder)
#
# Before running: Floci is up on 127.0.0.1:4566, the share_links table exists,
# and the ZIP has been built with:  node scripts/package-lambda.js
#
# Safety: this script can only talk to a loopback endpoint (127.0.0.1 or
# localhost), always uses Floci's dummy credentials (never your AWS profile),
# and stops unless the account is Floci's 000000000000. It never deletes
# anything. Running it again updates the code and settings in place.
set -euo pipefail

FLOCI_ENDPOINT="${FLOCI_ENDPOINT:-http://127.0.0.1:4566}"
REGION="us-east-1"
FUNCTION_NAME="class-tt-compare-share"
ROLE_NAME="class-tt-compare-share-lambda"
POLICY_NAME="class-tt-compare-share-least-privilege"
ZIP_PATH="${LAMBDA_ZIP:-D:/Downloadss/class-tt-local-test/lambda/compare-share-lambda.zip}"
# "pwd -W" gives a Windows path (D:/...) in Git Bash, which the Windows AWS CLI
# needs for file:// arguments; other systems fall back to plain pwd.
HERE="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"

# Settings passed to the function (override any of them before running).
SHARE_TABLE_NAME="${SHARE_TABLE_NAME:-share_links}"
# Inside a Lambda container "localhost" is the container itself, so Floci and
# the PC are reached by Docker names:
DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT:-http://floci:4566}"
CATALOGUE_JWKS_URL="${CATALOGUE_JWKS_URL:-http://host.docker.internal:3000/.well-known/jwks.json}"
TIMETABLE_SERVICE_URL="${TIMETABLE_SERVICE_URL:-http://host.docker.internal:3002}"
TERM_START_DATE="${TERM_START_DATE:-2026-09-13}"
TERM_END_DATE="${TERM_END_DATE:-2026-12-31}"
TIMEZONE="${TIMEZONE:-Africa/Cairo}"

# --- guard: local emulator only ---------------------------------------------
if [[ ! "$FLOCI_ENDPOINT" =~ ^http://(127\.0\.0\.1|localhost):[0-9]+$ ]]; then
  echo "Refusing: FLOCI_ENDPOINT must be a local address (http://127.0.0.1:<port>), got $FLOCI_ENDPOINT" >&2
  exit 1
fi
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_SESSION_TOKEN
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_PAGER=""

awsl() {
  # stdin closed and pager off: the AWS CLI otherwise hangs on this Windows setup.
  aws --endpoint-url "$FLOCI_ENDPOINT" --region "$REGION" --no-cli-pager --output json "$@" < /dev/null
}

ACCOUNT="$(awsl sts get-caller-identity --query Account --output text)"
if [[ "$ACCOUNT" != "000000000000" ]]; then
  echo "Refusing: account is $ACCOUNT, not Floci's 000000000000" >&2
  exit 1
fi
[[ -f "$ZIP_PATH" ]] || { echo "ZIP not found: $ZIP_PATH (run node scripts/package-lambda.js)" >&2; exit 1; }

# --- IAM role with least-privilege inline policy -----------------------------
if ! awsl iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  awsl iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "file://$HERE/deploy/lambda-trust-policy.json" >/dev/null
  echo "created role $ROLE_NAME"
fi
awsl iam put-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" \
  --policy-document "file://$HERE/deploy/lambda-permissions-policy.json"
ROLE_ARN="$(awsl iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)"

ENV_JSON="Variables={SHARE_TABLE_NAME=$SHARE_TABLE_NAME,DYNAMODB_ENDPOINT=$DYNAMODB_ENDPOINT,CATALOGUE_JWKS_URL=$CATALOGUE_JWKS_URL,TIMETABLE_SERVICE_URL=$TIMETABLE_SERVICE_URL,TERM_START_DATE=$TERM_START_DATE,TERM_END_DATE=$TERM_END_DATE,TIMEZONE=$TIMEZONE}"

# --- function ----------------------------------------------------------------
if awsl lambda get-function --function-name "$FUNCTION_NAME" >/dev/null 2>&1; then
  awsl lambda update-function-code --function-name "$FUNCTION_NAME" --zip-file "fileb://$ZIP_PATH" >/dev/null
  awsl lambda wait function-updated --function-name "$FUNCTION_NAME"
  awsl lambda update-function-configuration --function-name "$FUNCTION_NAME" \
    --role "$ROLE_ARN" --runtime nodejs22.x --handler src/lambda.handler \
    --memory-size 256 --timeout 15 --environment "$ENV_JSON" >/dev/null
  echo "updated function $FUNCTION_NAME"
else
  awsl lambda create-function --function-name "$FUNCTION_NAME" \
    --runtime nodejs22.x --handler src/lambda.handler --role "$ROLE_ARN" \
    --zip-file "fileb://$ZIP_PATH" --memory-size 256 --timeout 15 \
    --environment "$ENV_JSON" >/dev/null
  echo "created function $FUNCTION_NAME"
fi
awsl lambda wait function-active-v2 --function-name "$FUNCTION_NAME" || true
awsl lambda get-function-configuration --function-name "$FUNCTION_NAME" \
  --query '{name:FunctionName,runtime:Runtime,handler:Handler,memory:MemorySize,timeout:Timeout,state:State,role:Role}'
