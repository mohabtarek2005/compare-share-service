#!/usr/bin/env bash
# CloudWatch logging and monitoring for the Compare & Share Lambda on LOCAL Floci.
#
#   bash scripts/deploy-floci-monitoring.sh        (from the mohab folder)
#
# Floci 2.5.0 does not publish AWS/Lambda metrics, so monitoring is built from
# the function's own structured logs (requestLogger.js) with log-based metric
# filters, plus alarms on those metrics.
#
# Safety: only a loopback endpoint is accepted, Floci's dummy credentials are
# forced and the script stops unless the account is 000000000000. All calls are
# create-or-update ("put"), so re-running never duplicates anything, and nothing
# is ever deleted.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # keep "/aws/lambda/..." as-is in Git Bash

FLOCI_ENDPOINT="${FLOCI_ENDPOINT:-http://127.0.0.1:4566}"
REGION="us-east-1"
LOG_GROUP="/aws/lambda/class-tt-compare-share"
NAMESPACE="ClassTT/CompareShare"
RETENTION_DAYS=14

if [[ ! "$FLOCI_ENDPOINT" =~ ^http://(127\.0\.0\.1|localhost):[0-9]+$ ]]; then
  echo "Refusing: FLOCI_ENDPOINT must be a local address (http://127.0.0.1:<port>), got $FLOCI_ENDPOINT" >&2
  exit 1
fi
unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_SESSION_TOKEN
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_PAGER=""
awsl() { aws --endpoint-url "$FLOCI_ENDPOINT" --region "$REGION" --no-cli-pager --output text "$@" < /dev/null; }

[[ "$(awsl sts get-caller-identity --query Account)" == "000000000000" ]] || { echo "Refusing: not Floci's account" >&2; exit 1; }

# The log group is created by Lambda on first use; create it if it is missing.
if [[ "$(awsl logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" --query "logGroups[?logGroupName=='$LOG_GROUP'] | length(@)")" == "0" ]]; then
  awsl logs create-log-group --log-group-name "$LOG_GROUP"
  echo "created log group $LOG_GROUP"
fi
awsl logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days "$RETENTION_DAYS"
echo "retention $RETENTION_DAYS days on $LOG_GROUP"

# name | filter pattern | metric value
put_filter() {
  awsl logs put-metric-filter --log-group-name "$LOG_GROUP" --filter-name "$1" --filter-pattern "$2" \
    --metric-transformations "metricName=$1,metricNamespace=$NAMESPACE,metricValue=$3"
  echo "metric filter $1"
}
put_filter Requests            '{ $.event = "http.request" }'                       1
put_filter ServerErrors        '{ $.event = "http.request" && $.status >= 500 }'    1
put_filter AuthFailures        '{ $.event = "http.request" && $.status = 401 }'     1
put_filter DependencyFailures  '{ $.event = "http.request" && $.outcome = "dependency_failure" }' 1
put_filter LatencyMs           '{ $.event = "http.request" }'                       '$.durationMs'
# Crashes of the function itself (the Node runtime's "Invoke Error" line), kept
# separate from HTTP 5xx responses that the function returned normally.
put_filter LambdaInvocationErrors '"Invoke Error"'                                  1

# name | metric | threshold | period seconds
put_alarm() {
  awsl cloudwatch put-metric-alarm --alarm-name "$1" --namespace "$NAMESPACE" --metric-name "$2" \
    --statistic Sum --period "$4" --evaluation-periods 1 --threshold "$3" \
    --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching \
    --alarm-description "$5"
  echo "alarm $1"
}
put_alarm class-tt-compare-share-5xx               ServerErrors           1 60  "Any HTTP 5xx answered by Compare & Share in one minute"
put_alarm class-tt-compare-share-auth-failures     AuthFailures           5 300 "5 or more 401 responses in 5 minutes (possible token guessing)"
put_alarm class-tt-compare-share-invocation-errors LambdaInvocationErrors 1 60  "The Lambda function itself failed (not an HTTP error response)"

awsl cloudwatch describe-alarms --alarm-name-prefix class-tt-compare-share --query 'MetricAlarms[].[AlarmName,StateValue]'
