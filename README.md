# DeployGuard Ubuntu migration source backup — 2026-10-24

This archival branch contains source versions, reports, diagrams, presentation assets and recovered uncommitted Git objects. It is not a deployment release.

The original version1 release remains 7799fbd07d6c0d3988d3a6235a43254519fa0cf4. Main, existing branches, tags, release references and executable workflow pins were not changed by the preservation process.

## Restore and inspect

Fetch all `backup/ubuntu-20261024/*` branches from Hassan-Sajjad72/Deploy-Guard-dev. `preservation/history-branches.json` and `preservation/snapshot-branches.json` list their full commit SHAs. `preservation/commit-map.json` maps original local-only commits to safe archival equivalents. Author, committer, message and parent relationships are retained; sensitive paths and generated artifacts are removed in sanitized history. Original commit hashes therefore change where sanitization is required. No original local repository was rewritten.

`preservation/file-manifest.json` maps every selected file path to its exact Git blob and SHA-256. Files marked `reachable-history` are already preserved by the original public history or the history/snapshot backup branches. For any entry, restore its bytes with `git cat-file blob <blob-sha> > <destination>` after fetching the backup branches. Other entries also identify a path in this archival branch; identical contents are stored once.

`recovered-git-objects/` contains older staged or uncommitted source versions recovered using Git fsck. `preservation/orphan-trees.json` records their original tree paths. Runtime objects in that inventory are intentionally excluded; only decisions marked `candidate` in `preservation/orphan-final-decisions.json` are selected for preservation.

## Deletions and work in progress

`backup/ubuntu-20261024/version1-local-deletions` records the 32 local deletions. All deleted documents, diagrams and presentation images remain available in unchanged version1 history. Separate working-tree branches preserve the Grafana container change, dependency-security work and release1 documentation. Local Claude permissions and browser profiles are excluded.

## Security exclusions

Runtime .env files and .env templates in newly sanitized history, private keys, credential files, Terraform state/plans/runtime workspaces, database dumps and contents, browser data, caches, generated analysis output and temporary files are excluded. Original source SQL schema remains source code, not a database dump.

An orphaned environment backup contained credential material, including AWS credentials and a GitHub token, and is excluded in full. Two test-matrix PDFs contained credential-like examples. Their original PDFs are excluded; `sanitized-documents/` preserves redacted text equivalents. The untracked DOC Document.docx is an empty WPS template with zero words and is excluded.

Gitleaks scans cover newly reachable commit differences, complete candidate source blobs, expanded source archives, extracted Office/PDF text and OCR of image content. Findings in verification code are reviewed synthetic fixtures, action/workflow hashes or architecture prose. No credential values or raw scanner matches are included in this report.

The final verification receipt is published on `backup/ubuntu-20261024/verification`. Sensitive runtime data is intentionally not backed up by this source-code preservation task.
