FROM grafana/grafana:12.1.0

USER root

COPY monitoring/grafana/provisioning /etc/grafana/provisioning
COPY monitoring/grafana/dashboards /etc/grafana/dashboards
RUN sed -i 's|/var/lib/grafana/dashboards|/etc/grafana/dashboards|' \
  /etc/grafana/provisioning/dashboards/deployguard.yml

USER grafana
