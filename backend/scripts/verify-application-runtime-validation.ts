import "reflect-metadata";
import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { GithubActionsService } from "../src/projects/pipeline/github-actions.service";
import { githubActionsFailureLifecyclePhase, githubActionsWorkflowStepPresentation } from "../src/projects/pipeline/github-actions-stage-presentation";

const root = join(__dirname, "..", "..");
const workflow = readFileSync(join(root, ".github", "workflows", "deployguard-reusable.yml"), "utf8");
const orderedSteps = [
  "Checkout exact application source",
  "Configure AWS credentials through OIDC",
  "Validate immutable release input",
  "Install pinned Railpack",
  "Build immutable Railpack images",
  "Validate Application Runtime",
  "Publish immutable images to ECR",
  "Install Terraform",
  "Materialize release runtime",
];

function stepBlock(name: string, nextName: string) {
  const start = workflow.indexOf(`      - name: ${name}`);
  const end = workflow.indexOf(`      - name: ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} must precede ${nextName}`);
  return workflow.slice(start, end);
}

function runScript(block: string) {
  const marker = "        run: |\n";
  const start = block.indexOf(marker);
  assert.ok(start >= 0, "runtime validation must be a shell step");
  return block.slice(start + marker.length).split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n").trim();
}

const validationBlock = stepBlock("Validate Application Runtime", "Publish immutable images to ECR");
const validationScript = runScript(validationBlock);

function executable(path: string, source: string) {
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

function executeProbe(mode: "success" | "timeout" | "exited" | "run_failure" | "workflow_failure") {
  const directory = mkdtempSync(join(tmpdir(), "deployguard-runtime-validation-"));
  const trace = join(directory, "trace");
  executable(join(directory, "docker"), `#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\\n' "$*" >> "$TRACE_FILE"
case "$1" in
  image) printf 'sha256:%064d\n' 0 ;;
  network) ;;
  run)
    [ "$PROBE_MODE" != run_failure ] || exit 1
    printf 'probe-container\\n'
    ;;
  inspect)
    if [[ "$*" == *State.Running* ]]; then
      [ "$PROBE_MODE" != exited ] && printf 'true\\n' || printf 'false\\n'
    else
      printf '172.18.0.2\\n'
    fi
    ;;
  logs) printf 'bounded probe log\\n' ;;
esac
`);
  executable(join(directory, "aws"), "#!/usr/bin/env bash\nexit 99\n");
  executable(join(directory, "timeout"), `#!/usr/bin/env bash
printf 'tcp %s\\n' "$*" >> "$TRACE_FILE"
if [ "$1" = --signal=TERM ]; then
  [ "$PROBE_MODE" != timeout ] || exit 124
  shift 2
  exec "$@"
fi
[ "$PROBE_MODE" = success ] || [ "$PROBE_MODE" = workflow_failure ]
`);
  executable(join(directory, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  const downstream = join(directory, "downstream");
  const deployguard = join(directory, ".deployguard");
  require("node:fs").mkdirSync(deployguard);
  const serviceId = "11111111-1111-4111-8111-111111111111";
  writeFileSync(join(deployguard, "build-artifacts.json"), JSON.stringify([{ serviceId, localImage: "registry.example/app:exact-sha", localImageId: `sha256:${"0".repeat(64)}` }]), "utf8");
  writeFileSync(join(deployguard, "runtime.json"), JSON.stringify({ services: [{ serviceId, environment: { PORT: "8080", HOST: "0.0.0.0", REQUIRED_RUNTIME_VALUE: "present" }, secretReferences: {}, databaseAttached: false, managedDatabase: { engine: null, aliases: [] } }] }), "utf8");
  const suffix = mode === "workflow_failure"
    ? "\nfalse\nprintf 'ECR\\nTerraform\\n' > \"$DOWNSTREAM_FILE\""
    : "\nprintf 'ECR\\nTerraform\\n' > \"$DOWNSTREAM_FILE\"";
  const result = spawnSync("bash", ["-c", `${validationScript}${suffix}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      PROBE_IMAGE: "registry.example/app:exact-sha",
      OPERATION_ID: "22222222-2222-4222-8222-222222222222",
      PROBE_MODE: mode,
      TRACE_FILE: trace,
      DOWNSTREAM_FILE: downstream,
    },
    cwd: directory,
  });
  const observed = {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    trace: readFileSync(trace, "utf8"),
    downstream: (() => { try { return readFileSync(downstream, "utf8"); } catch { return ""; } })(),
  };
  rmSync(directory, { recursive: true, force: true });
  return observed;
}

async function verifyStageProjection() {
  const expected = [
    ["checkout_exact_application_source", "Checkout Source"],
    ["configure_aws_credentials_through_oidc", "Authenticate AWS"],
    ["validate_immutable_release_input", "Validate Release"],
    ["install_pinned_railpack", "Prepare Build"],
    ["build_immutable_railpack_images", "Build Applications"],
    ["validate_application_runtime", "Validate Application Runtime"],
    ["publish_immutable_images_to_ecr", "Publish Images"],
  ];
  const service = Object.create(GithubActionsService.prototype) as any;
  service.getWorkflowJobs = async () => ({ jobs: [{ steps: orderedSteps.slice(0, 7).map((name) => ({ name, status: "completed", conclusion: "success" })) }] });
  const stages = await service.getWorkflowStages("example/app", "1", "token", "deploy");
  assert.deepEqual(stages.map((stage: any) => [stage.key, stage.label]), expected);
  assert.equal(new Set(stages.map((stage: any) => stage.label)).size, expected.length, "early deploy stages must have distinct labels");
  assert.equal(githubActionsWorkflowStepPresentation("Validate Application Runtime", "rollback"), null);
  assert.equal(githubActionsWorkflowStepPresentation("Validate Application Runtime", "destroy"), null);
  assert.equal(githubActionsFailureLifecyclePhase("validate_application_runtime", "deploy"), "build");
}

void (async () => {
  let previous = -1;
  for (const step of orderedSteps) {
    const position = workflow.indexOf(`      - name: ${step}`);
    assert.ok(position > previous, `${step} is out of deploy order`);
    previous = position;
  }
  assert.match(validationBlock, /if: success\(\) && inputs\.deployment_action == 'deploy'/);
  assert.match(validationScript, /docker image inspect --format '\{\{\.Id\}\}' "\$image"/);
  assert.match(validationScript, /\.environment \| to_entries\[\] \| @base64/);
  assert.match(validationScript, /\.secretReferences \| to_entries\[\] \| @base64/);
  assert.match(validationScript, /get-secret-value --secret-id "\$secret_id" --version-id "\$version_id"/);
  assert.match(validationScript, /runtime_args\+=\(--env "\$key"\)/, "runtime values are inherited without appearing in Docker argv");
  for (const [engine, image, readiness] of [["postgres", "postgres:16", "pg_isready"], ["mysql", "mysql:8", "mysqladmin ping"], ["mongodb", "mongo:8", "mongosh"]]) {
    assert.match(validationScript, new RegExp(`${engine}\\) database_image=\\"${image}\\"`));
    assert.match(validationScript, new RegExp(readiness));
  }
  assert.match(validationScript, /\.managedDatabase\.aliases\[\]/);
  assert.match(validationScript, /timeout --signal=TERM 45 bash -c/);
  assert.match(validationScript, /while \[ "\$stable" -lt 5 \]/, "readiness must prove a durable process and port");
  assert.match(validationScript, /\/dev\/tcp\/\\\$1\/8080/);
  assert.doesNotMatch(validationScript, /\bcurl\b|\bwget\b|https?:\/\//, "pre-publish validation must be TCP-only");
  assert.match(validationScript, /docker logs .*--tail 100[\s\S]*tail -c 12000/);
  assert.match(validationScript, /Application did not listen on PORT=8080 within 45 seconds\. Bind to 0\.0\.0\.0 and use the PORT environment variable\./);
  assert.match(workflow, /name: Clean up application runtime validation[\s\S]*if: always\(\) && inputs\.deployment_action == 'deploy'[\s\S]*deployguard-runtime-probe-\$\{OPERATION_ID\}-/);
  assert.match(stepBlock("Publish immutable images to ECR", "Select immutable rollback service images"), /if: success\(\)/);
  assert.match(stepBlock("Install Terraform", "Materialize release runtime"), /if: success\(\)/);
  const deployedReadiness = stepBlock("Materialize release runtime", "Publish verified release result");
  assert.match(deployedReadiness, /curl --show-error --silent --retry 20[\s\S]*--output \/dev\/null/, "post-ALB verification proves public reachability");
  assert.doesNotMatch(deployedReadiness, /curl --fail/, "HTTP business status must not decide deployment readiness");

  const success = executeProbe("success");
  assert.equal(success.status, 0);
  assert.equal(success.downstream, "ECR\nTerraform\n", "successful TCP validation continues to downstream stages");
  assert.match(success.trace, /docker image inspect --format \{\{\.Id\}\} registry\.example\/app:exact-sha/);
  assert.match(success.trace, /docker run .*--env PORT --env HOST --env REQUIRED_RUNTIME_VALUE sha256:0{64}/);
  assert.match(success.trace, /docker rm --force deployguard-runtime-probe-22222222-2222-4222-8222-222222222222-11111111/);

  for (const mode of ["timeout", "exited", "run_failure", "workflow_failure"] as const) {
    const result = executeProbe(mode);
    assert.notEqual(result.status, 0, `${mode} must fail the composed workflow path`);
    assert.equal(result.downstream, "", `${mode} must not reach ECR or Terraform`);
    assert.match(result.trace, /docker rm --force deployguard-runtime-probe-22222222-2222-4222-8222-222222222222-11111111/, `${mode} must clean up the probe container`);
    if (mode === "timeout" || mode === "exited") assert.match(result.stderr, /Application did not listen on PORT=8080 within 45 seconds/);
  }
  const timeout = executeProbe("timeout");
  assert.match(timeout.trace, /^tcp --signal=TERM 45 bash -c/m, "the entire wait loop has one hard 45-second deadline");
  await verifyStageProjection();
  console.log("APPLICATION_RUNTIME_VALIDATION=PASS TCP_ONLY=1 TIMEOUT_SECONDS=45 DOWNSTREAM_FAIL_CLOSED=1 CLEANUP_ALL_PATHS=1");
})().catch((error) => { console.error(error); process.exitCode = 1; });
