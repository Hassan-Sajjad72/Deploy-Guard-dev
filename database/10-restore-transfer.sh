#!/bin/sh
set -eu

dump=/transfer/deployguard-postgres.dump
if [ ! -f "$dump" ]; then
  echo "No transferred DeployGuard database dump found; starting with an empty database."
  exit 0
fi

pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-owner --no-privileges "$dump"
