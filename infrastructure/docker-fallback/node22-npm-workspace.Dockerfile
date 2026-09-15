# syntax=docker/dockerfile:1.7
FROM node:22.14.0-bookworm-slim@sha256:745403dc46b5ab4c998502b07a12cbf020cf2c30645427a68ec0718f02d647de AS build

WORKDIR /workspace
COPY . .
ARG DG_PACKAGE_TARGET
RUN --mount=type=secret,id=deployguard_build_environment,required=true \
    --mount=type=secret,id=deployguard_build_secrets,required=true \
    node -e 'const fs=require("fs"),cp=require("child_process"); const read=p=>JSON.parse(fs.readFileSync(p,"utf8")); const env={...process.env,...read("/run/secrets/deployguard_build_environment"),...read("/run/secrets/deployguard_build_secrets")}; for(const args of [["ci","--workspaces","--include-workspace-root"],["--workspace",process.env.DG_PACKAGE_TARGET,"run","build"]]) { const result=cp.spawnSync("npm",args,{env,stdio:"inherit"}); if(result.error) throw result.error; if(result.status!==0) process.exit(result.status??1); }'

FROM node:22.14.0-bookworm-slim@sha256:745403dc46b5ab4c998502b07a12cbf020cf2c30645427a68ec0718f02d647de AS runtime
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace /workspace
ARG DG_PACKAGE_TARGET
ENV DG_PACKAGE_TARGET=${DG_PACKAGE_TARGET}
USER node
CMD ["node", "-e", "const cp=require('child_process');const child=cp.spawn('npm',['--workspace',process.env.DG_PACKAGE_TARGET,'run','start'],{stdio:'inherit'});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));child.on('exit',(code,signal)=>signal?process.kill(process.pid,signal):process.exit(code??1));"]
