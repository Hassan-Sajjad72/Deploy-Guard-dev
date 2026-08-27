FROM nginxinc/nginx-unprivileged:1.27-alpine
LABEL org.opencontainers.image.revision="{{COMMIT_SHA}}"
COPY --chown=101:101 . /usr/share/nginx/html
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080{{HEALTH_CHECK_PATH}} || exit 1
