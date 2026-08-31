import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { get } from "node:https";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const toolsRoot = join(root, ".cache", "certification-tools");

const tools = [
  {
    name: "actionlint",
    version: "1.7.12",
    url: "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz",
    sha256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
    archive: "actionlint.tar.gz",
    binary: "actionlint",
    extract: ["-xzf"],
  },
  {
    name: "shellcheck",
    version: "0.11.0",
    url: "https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.x86_64.tar.xz",
    sha256: "8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198",
    archive: "shellcheck.tar.xz",
    binary: "shellcheck-v0.11.0/shellcheck",
    extract: ["-xJf"],
  },
];

function download(url, destination) {
  return new Promise((resolveDownload, reject) => {
    const request = get(url, { headers: { "User-Agent": "deployguard-certification" } }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(response.headers.location, destination).then(resolveDownload, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}: ${url}`));
        return;
      }
      const stream = createWriteStream(destination, { mode: 0o600 });
      response.pipe(stream);
      stream.on("finish", () => stream.close(resolveDownload));
      stream.on("error", reject);
    });
    request.on("error", reject);
  });
}

mkdirSync(toolsRoot, { recursive: true });
for (const tool of tools) {
  const directory = join(toolsRoot, `${tool.name}-${tool.version}`);
  const binary = join(directory, tool.binary);
  if (!existsSync(binary)) {
    mkdirSync(directory, { recursive: true });
    const archive = join(directory, `${tool.archive}.partial`);
    await download(tool.url, archive);
    const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
    if (actual !== tool.sha256) throw new Error(`${tool.name} archive checksum mismatch`);
    const finalArchive = join(directory, tool.archive);
    renameSync(archive, finalArchive);
    const extracted = spawnSync("tar", [...tool.extract, finalArchive, "-C", directory], { stdio: "inherit" });
    if (extracted.status !== 0) throw new Error(`Could not extract ${tool.name}`);
  }
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
  if (version.status !== 0 || !`${version.stdout}${version.stderr}`.includes(tool.version)) {
    throw new Error(`${tool.name} ${tool.version} did not execute correctly`);
  }
  console.log(`${tool.name.toUpperCase()}=${tool.version} PATH=${binary}`);
}
