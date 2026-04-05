#!/usr/bin/env bash

set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

failures=0

pass() {
	printf "✅ %s\n" "$1"
}

fail() {
	printf "❌ %s\n" "$1"
	failures=$((failures + 1))
}

expect_code() {
	local name="$1"
	local expected="$2"
	local actual
	actual=$(curl -sS -o /dev/null -w "%{http_code}" "$3")
	if [[ "$actual" == "$expected" ]]; then
		pass "$name (HTTP $actual)"
	else
		fail "$name (expected HTTP $expected, got $actual)"
	fi
}

extract_json_field() {
	local json="$1"
	local field="$2"
	echo "$json" | sed -n "s/.*\"$field\":\"\([^\"]*\)\".*/\1/p"
}

echo "==> Checking baseline health endpoints"
expect_code "dub-links health" "200" "http://localhost:3000/health"
expect_code "trigger-bg health" "200" "http://localhost:3001/health"
expect_code "coolify-paas health" "200" "http://localhost:3002/health"
expect_code "hopp-test health" "200" "http://localhost:3003/health"
expect_code "paper-cups health" "200" "http://localhost:4000/health"
expect_code "pocket-base health" "200" "http://localhost:8080/health"
expect_code "gateway health" "200" "http://localhost/healthz"

echo "==> Checking trigger-bg auth + enqueue"
unauth_code=$(curl -sS -o /dev/null -w "%{http_code}" -X POST http://localhost:3001/api/jobs -H 'Content-Type: application/json' -d '{"name":"smoke","payload":{}}')
if [[ "$unauth_code" == "401" ]]; then
	pass "trigger-bg rejects unauthorized enqueue"
else
	fail "trigger-bg unauthorized enqueue expected 401, got $unauth_code"
fi

trigger_enqueue=$(curl -sS -X POST http://localhost:3001/api/jobs -H 'Content-Type: application/json' -H 'X-API-Key: change-me' -d '{"name":"smoke","payload":{"simulateMs":100}}')
trigger_job_id=$(extract_json_field "$trigger_enqueue" "id")
if [[ -n "$trigger_job_id" ]]; then
	pass "trigger-bg accepted authenticated enqueue (job $trigger_job_id)"
	sleep 1
	expect_code "trigger-bg job detail" "200" "http://localhost:3001/api/jobs/$trigger_job_id"
	result_code=$(curl -sS -o /dev/null -w "%{http_code}" "http://localhost:3001/api/jobs/$trigger_job_id/result")
	if [[ "$result_code" == "200" || "$result_code" == "409" ]]; then
		pass "trigger-bg job result endpoint reachable (HTTP $result_code)"
	else
		fail "trigger-bg job result unexpected HTTP $result_code"
	fi
else
	fail "trigger-bg enqueue response missing job id"
fi

echo "==> Checking dub-links create + redirect"
dub_slug="smoke-$(date +%s)"
dub_create=$(curl -sS -X POST http://localhost:3000/api/links -H 'Content-Type: application/json' -H 'X-API-Key: change-me' -d "{\"url\":\"https://example.com\",\"slug\":\"$dub_slug\"}")
created_slug=$(extract_json_field "$dub_create" "slug")
if [[ "$created_slug" == "$dub_slug" ]]; then
	pass "dub-links created short link ($dub_slug)"
	expect_code "dub-links fetch link" "200" "http://localhost:3000/api/links/$dub_slug"
	redirect_code=$(curl -sS -o /dev/null -w "%{http_code}" "http://localhost:3000/$dub_slug")
	if [[ "$redirect_code" == "302" ]]; then
		pass "dub-links redirect works (HTTP 302)"
	else
		fail "dub-links redirect expected 302, got $redirect_code"
	fi
else
	fail "dub-links failed to create short link"
fi

echo "==> Checking pocket-base register/login"
pocket_email="smoke.$(date +%s)@example.com"
pocket_register_code=$(curl -sS -o /dev/null -w "%{http_code}" -X POST http://localhost:8080/auth/register -H 'Content-Type: application/json' -d "{\"email\":\"$pocket_email\",\"password\":\"password123\"}")
if [[ "$pocket_register_code" == "201" ]]; then
	pass "pocket-base register works"
else
	fail "pocket-base register expected 201, got $pocket_register_code"
fi

pocket_login=$(curl -sS -X POST http://localhost:8080/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$pocket_email\",\"password\":\"password123\"}")
pocket_token=$(extract_json_field "$pocket_login" "token")
if [[ -n "$pocket_token" ]]; then
	pass "pocket-base login works (token issued)"
else
	fail "pocket-base login failed to return token"
fi

echo "==> Checking coolify-paas + hopp-test functional endpoints"
expect_code "coolify-paas apps" "200" "http://localhost:3002/apps"
expect_code "hopp-test workspace" "200" "http://localhost:3003/workspace"

echo "==> Checking gateway reverse-proxy routes"
expect_code "gateway trigger route" "200" "http://localhost/trigger/health"
expect_code "gateway dub route" "200" "http://localhost/dub/health"
expect_code "gateway pocket route" "200" "http://localhost/pocket/health"
expect_code "gateway paper route" "200" "http://localhost/paper/health"
expect_code "gateway coolify route" "200" "http://localhost/coolify/health"
expect_code "gateway hopp route" "200" "http://localhost/hopp/health"

echo
if [[ "$failures" -eq 0 ]]; then
	echo "🎉 Smoke test passed: all checked services responded correctly."
	exit 0
else
	echo "⚠️ Smoke test completed with $failures failure(s)."
	exit 1
fi
