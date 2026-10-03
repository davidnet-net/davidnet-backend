#!/bin/sh
# Bootstraps the local dev Garage instance: waits for it to come up, then makes sure the
# dev access key and all buckets the backend expects exist with read/write access.
# Safe to run on every `docker compose up` — every step here is idempotent.
set -eu

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

echo "[garage-init] Importing dev access key (ok if it already exists)..."
garage key import "$GARAGE_ACCESS_KEY" "$GARAGE_SECRET_KEY" -n local-dev --yes >/dev/null 2>&1 || true

for bucket in profile-pictures banner-pictures shorts communitygames; do
	echo "[garage-init] Ensuring bucket '$bucket' exists with read/write access..."
	garage bucket create "$bucket" >/dev/null 2>&1 || true
	garage bucket allow --read --write "$bucket" --key "$GARAGE_ACCESS_KEY" >/dev/null
done

echo "[garage-init] Done. Buckets ready: profile-pictures, banner-pictures, shorts, communitygames."
