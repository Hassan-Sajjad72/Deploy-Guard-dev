#!/bin/sh
set -eu

escaped_token=$(printf '%s' "${PROMETHEUS_SCRAPE_TOKEN:?PROMETHEUS_SCRAPE_TOKEN is required}" | sed 's/[\\&|]/\\&/g')
escaped_target=$(printf '%s' "${PROMETHEUS_SCRAPE_TARGET:-backend:5000}" | sed 's/[\\&|]/\\&/g')
sed -e "s|__DEPLOYGUARD_SCRAPE_TOKEN__|$escaped_token|g" \
  -e "s|__DEPLOYGUARD_SCRAPE_TARGET__|$escaped_target|g" \
  /etc/prometheus/prometheus.yml.template > /tmp/prometheus.yml

exec /bin/prometheus \
  --config.file=/tmp/prometheus.yml \
  --storage.tsdb.path=/prometheus \
  --storage.tsdb.retention.time=7d
