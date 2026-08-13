FROM hashicorp/terraform:1.10.5 AS terraform

FROM node:22-bookworm-slim

ARG INFRACOST_VERSION=2.12.2
ARG INFRACOST_LINUX_AMD64_SHA256=37eb24e60825b4301352d587b39e015b9c8b45758f4c3efb297141be823f9760
ARG AWS_CLI_VERSION=2.35.17
ARG AWS_CLI_LINUX_X86_64_SHA256=ba326932b8ca7fef7b6e37b9475be702327a9d5aef157f07300d8d34993902c3

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git unzip \
    && test "$(dpkg --print-architecture)" = "amd64" \
    && curl -fsSL --retry 3 \
      "https://github.com/infracost/cli/releases/download/v${INFRACOST_VERSION}/infracost-linux-amd64.tar.gz" \
      -o /tmp/infracost.tar.gz \
    && echo "${INFRACOST_LINUX_AMD64_SHA256}  /tmp/infracost.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/infracost.tar.gz -C /usr/local/bin \
    && chmod 0755 /usr/local/bin/infracost \
    && curl -fsSL --retry 3 \
      "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWS_CLI_VERSION}.zip" \
      -o /tmp/awscliv2.zip \
    && echo "${AWS_CLI_LINUX_X86_64_SHA256}  /tmp/awscliv2.zip" | sha256sum -c - \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli \
    && infracost --version \
    && aws --version \
    && rm -rf /tmp/aws /tmp/awscliv2.zip /tmp/infracost.tar.gz \
    && rm -rf /var/lib/apt/lists/*

COPY --from=terraform /bin/terraform /usr/local/bin/terraform

WORKDIR /workspace/backend
