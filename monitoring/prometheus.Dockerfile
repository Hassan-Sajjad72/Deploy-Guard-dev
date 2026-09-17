FROM prom/prometheus:v3.5.0
COPY monitoring/prometheus.compose.yml /etc/prometheus/prometheus.yml.template
COPY --chmod=0755 monitoring/start-prometheus.sh /usr/local/bin/start-prometheus
ENTRYPOINT ["/usr/local/bin/start-prometheus"]
