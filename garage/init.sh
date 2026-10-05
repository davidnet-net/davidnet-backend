#!/bin/sh
# Bootstraps a Garage instance (local dev via docker-compose, or the cluster sidecar): waits
# for it to come up, then makes sure the access key and all buckets the backend expects exist
# with read/write access. Safe to run every time — every step here is idempotent.
#
# Env vars (all optional, default to the local-dev setup):
#   GARAGE_BUCKETS        space-separated bucket list (default: today's local-dev set)
#   GARAGE_INIT_KEY_NAME  name to register the key under (default: local-dev)
#   GARAGE_INIT_KEEP_ALIVE  "true" to sleep forever after provisioning instead of exiting
#                           (needed for a long-running cluster sidecar container; local dev's
#                           one-shot container leaves this unset and exits normally)
set -eu

GARAGE_BUCKETS="${GARAGE_BUCKETS:-profile-pictures banner-pictures shorts communitygames quiz-images feedback}"
GARAGE_INIT_KEY_NAME="${GARAGE_INIT_KEY_NAME:-local-dev}"

echo "[garage-init] Waiting for Garage RPC to come up..."
i=0
until garage status >/dev/null 2>&1; do
	i=$((i + 1))
	if [ "$i" -ge 60 ]; then
		echo "[garage-init] Garage did not become reachable in time" >&2
		exit 1
	fi
	sleep 1
done

echo "[garage-init] Importing access key '$GARAGE_INIT_KEY_NAME' (ok if it already exists)..."
garage key import "$GARAGE_ACCESS_KEY" "$GARAGE_SECRET_KEY" -n "$GARAGE_INIT_KEY_NAME" --yes >/dev/null 2>&1 || true

for bucket in $GARAGE_BUCKETS; do
	echo "[garage-init] Ensuring bucket '$bucket' exists with read/write access..."
	garage bucket create "$bucket" >/dev/null 2>&1 || true
	garage bucket allow --read --write "$bucket" --key "$GARAGE_ACCESS_KEY" >/dev/null
done

echo "[garage-init] Done. Buckets ready: $GARAGE_BUCKETS"

if [ "${GARAGE_INIT_KEEP_ALIVE:-false}" = "true" ]; then
	echo "[garage-init] Keep-alive requested, idling as a sidecar (not exiting)."
	exec sleep infinity
fi
