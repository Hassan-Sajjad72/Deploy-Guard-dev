# DeployGuard preservation report — 24 October 2026

**Audited source backup: VERIFIED on GitHub. Full-laptop OS migration: NOT CLEARED until restricted homes are checked.**

## Scope inspected

Seven independent local Git repositories across eight working checkouts, five relocated/broken linked-worktree directories, archived Git metadata, source archives, standalone source directories and DeployGuard documentation/presentation assets under `/home/hassan-sajjad`. Repository discovery also checked `/tmp` and accessible standard repository locations. No source repository was rewritten, switched, cleaned or staged by this task.

Working checkouts:
- `/home/hassan-sajjad/Projects/Deploy-Guard`
- `/home/hassan-sajjad/Deploy-Guard-final-container-setup`
- `/home/hassan-sajjad/deployguard_framework_apps_organized (1)/deployguard_framework_apps_organized`
- `/home/hassan-sajjad/deployguard-release-1`
- `/home/hassan-sajjad/deployguard-m0-clean-xeBIfY/checkout`
- `/home/hassan-sajjad/Deploy-Guard-dev-final-FYP2/Deploy-Guard-dev-final-3/Deploy-Guard-dev-test3`
- `/home/hassan-sajjad/Deploy-Guard-dev-final-FYP2/Deploy-Guard-dev-final-3/deployguard-team-runtime`
- `/home/hassan-sajjad/Deploy-Guard-dev-final-FYP2/Deploy-Guard-dev-final-3/Deploy-Guard-dev`

Additional source includes `~/frontend`, `~/FRONTZ`, the Atelier and VPS sources, teammate transfer sources, framework fixtures, source-only archive contents, Desktop/Downloads/WhatSie/MIGARTION documentation and FYP presentation material. Archived runtime history matched its live repository. A workspace archive contained one additional commit absent from the target repository; it is preserved in the archived-workspace history branch.

## Preserved and verified

- 68 data/history backup branches under `backup/ubuntu-20261024/`, plus this separate verification branch.
- 131 commits absent from the original target repository: 10 retain their exact IDs; 121 have sanitized equivalents. Author, committer, message, parent topology and every retained source blob were verified. The original-to-backup map is `commit-map.json`.
- Original raw commit headers/messages are retained as text in `original-commit-metadata/`, including three original signatures. These are provenance records; sanitized commits have new IDs and do not carry the original signatures.
- 14,560 selected file-path records across the two source manifests, representing 5,794 unique file contents. Each SHA-256 was checked against bytes read from an independent fresh GitHub fetch.
- 3,069 additional unique artifact blobs, including source versions, documentation, diagrams, presentations and 2,225 recovered orphaned source/documentation blobs. Existing identical contents are referenced through the manifests instead of duplicated.
- Local Grafana container changes, dependency-security changes and release1 documentation are preserved on separate working-tree branches.
- The 32 local deletions are recorded only on `version1-local-deletions`; its diff against the release parent is exactly 32 deletions. All deleted GitHub content remains in the unchanged release history.
- `git fsck --full` passed on the independent GitHub fetch. All 68 remote branch SHAs match their local expected SHAs and fetched SHAs. No selected source/file or safe commit-equivalent is missing within the audited scope. Final source-file checks found no drift.

## Stable release and workflow identities

`version1` remains `7799fbd07d6c0d3988d3a6235a43254519fa0cf4`.

`main` remains `6b31bdb93d29eb79eb6d830c19fb00a66ccd1d2a`.

Every pre-existing GitHub reference, including release tags and their targets, matches the pre-operation snapshot. Existing pinned workflow/action identities and release executable files were not edited. Pushes used explicit new branch references with atomic, non-force Git operations. Backup workflow triggers were reviewed: reusable deployment workflows require explicit calls, and image publishing is limited to `main`.

## Security exclusions and remaining data

Gitleaks 8.30.1 scans covered newly reachable commits, full source contents, expanded source archives, commit metadata, Office/PDF text and image OCR. Known synthetic verification fixtures, workflow hashes and prose findings were reviewed; no unresolved findings were published. Source/commit metadata was scanned before each push.

Excluded: environment files and templates from sanitized history; private keys and credential files; Terraform state, plans, variable values and runtime workspaces; database dumps and database contents; browser profiles, SQLite/WAL data, caches, generated build/analysis output, and temporary files. Source SQL schemas were verified as preserved. No known credential-containing orphan blob is reachable through newly published GitHub objects.

An orphaned environment backup contained AWS credentials and a GitHub token and was excluded in full. Original copies of two test-matrix PDFs containing credential-like examples were excluded; redacted text equivalents are preserved in `source-assets/sanitized-documents`. The empty untracked WPS `DOC Document.docx` template is excluded. Unrelated FlowOS/startup research PDFs were excluded from the DeployGuard archive supplement.

Sensitive/runtime originals intentionally remain outside this public source backup. Unsanitized history object IDs are recorded for provenance; excluded file contents were not published. The laptop's original repositories and working trees remain unchanged.

**Permission blocker:** `/home/devops-user`, `/home/devopsuser` and `/root` are not readable by the current user. Non-interactive privilege access returned exactly `sudo-rs: interactive authentication is required`. Checks in those locations stopped. Their contents and any possible DeployGuard work there remain unverified. This prevents unconditional full-laptop wipe clearance, even though the audited source backup is verified.

## Restore

Clone `https://github.com/Hassan-Sajjad72/Deploy-Guard-dev.git` with all branches. Check out `version1` for the exact stable release. The `source-assets` and `additional-source` branches contain restore manifests mapping original paths to Git blob IDs and SHA-256 checksums. After fetching the backups, restore any manifest entry with `git cat-file blob <blob-sha> > <destination>`.

`history-branches.json` identifies the archived source/history branches, and `snapshot-branches.json` identifies the working-tree snapshots. `verification-result.json` contains independent GitHub SHA readback results for every data/history branch. This report branch is published and read back separately after those checks.

## Complete data/history branch list

| GitHub branch | Verified commit SHA |
| --- | --- |
| `backup/ubuntu-20261024/additional-source` | `8480e29f78892d0234f45e75358a7a911e9c9b29` |
| `backup/ubuntu-20261024/container-working-tree` | `4923dcd709366469186768d8777451c4a591bde1` |
| `backup/ubuntu-20261024/history/archived-workspace/product-freeze-confirmed-fixes` | `450d31760e3d3474aac91925fef7069c76be3f3e` |
| `backup/ubuntu-20261024/history/early-prototype/Docker-templates` | `7d93d738a70428bf724d00bb120c0fe9d80ea143` |
| `backup/ubuntu-20261024/history/early-prototype/main` | `6f5aac32e1182d0744f483dd4afe2c6f14057825` |
| `backup/ubuntu-20261024/history/fixtures/Angular_Express_MongoDB` | `976655b9f3ed895b295ee9d866bc2943ba0437f7` |
| `backup/ubuntu-20261024/history/fixtures/Astro_Node_MongoDB` | `497a9eefd95ea0329c2afe5059d0e56f9b636b3a` |
| `backup/ubuntu-20261024/history/fixtures/Astro_Static_Fastify_MySQL` | `11c40cfc352c4c4c3a74b72cb1cd61277a19dae2` |
| `backup/ubuntu-20261024/history/fixtures/CRA_Express_PostgreSQL` | `bfc272a03a2a1223c73b33505bd92007a36bf0e4` |
| `backup/ubuntu-20261024/history/fixtures/Django_ASGI_MySQL` | `bb630fe7991e644f770be629d308df5d5a5b4a20` |
| `backup/ubuntu-20261024/history/fixtures/Django_WSGI_PostgreSQL` | `7013ef435657df66c7f161215fa73231f601fa79` |
| `backup/ubuntu-20261024/history/fixtures/Express_JS_PostgreSQL` | `e3c1baf644ed9118b6da60ff8893142b257d3dc1` |
| `backup/ubuntu-20261024/history/fixtures/Express_TS_MongoDB` | `4b8d655b1f9118e49fac266fdf5c02bf1265c24e` |
| `backup/ubuntu-20261024/history/fixtures/FastAPI_MySQL` | `b8811314bb31674a5e0c9139d713cdcb38c4867f` |
| `backup/ubuntu-20261024/history/fixtures/FastAPI_Nested_PostgreSQL` | `697c9aaa492179be362a4ca8fcf4421654c1f644` |
| `backup/ubuntu-20261024/history/fixtures/Fastify_JS_MySQL` | `ab575ec85e5c4cc8af88957067cce5062818d058` |
| `backup/ubuntu-20261024/history/fixtures/Fastify_TS_PostgreSQL` | `e9f2e6e2247bbc0d4f6791824e927ebb0d48b244` |
| `backup/ubuntu-20261024/history/fixtures/Flask_Factory_MongoDB` | `0a4bca85834a539e23c2b84a0dd397d1b1beeea6` |
| `backup/ubuntu-20261024/history/fixtures/Flask_PostgreSQL` | `d892258521b10f4b510623dc6962ed72613b8ad3` |
| `backup/ubuntu-20261024/history/fixtures/NestJS_MongoDB` | `a53a6dbca2ccb9dcb1ae2fae8b162252ffa0f26f` |
| `backup/ubuntu-20261024/history/fixtures/NextJS_SSR_PostgreSQL` | `ccb76a4bb0b8926a34b6b9bd721534c66c10027a` |
| `backup/ubuntu-20261024/history/fixtures/NextJS_Standalone_MongoDB` | `368b947b678a87a149e275bcd5987a83d1825c4c` |
| `backup/ubuntu-20261024/history/fixtures/NextJS_Static_Express_MySQL` | `62f8a00f2c58e42e351e729f1b4eb1160076a666` |
| `backup/ubuntu-20261024/history/fixtures/Nuxt_SSR_PostgreSQL` | `2edfdd048d787e2ac49945255ba0879da34b0482` |
| `backup/ubuntu-20261024/history/fixtures/Nuxt_Static_Fastify_MongoDB` | `67bc7f39b8d1c32bf68528ff394bb2263d88a84d` |
| `backup/ubuntu-20261024/history/fixtures/Remix_Node_PostgreSQL` | `4b6ae8b1dbad3fd458544d08ca394c1a0f5ca05e` |
| `backup/ubuntu-20261024/history/fixtures/Streamlit_MongoDB` | `bf6f17064a4b46be548267c4f041d0fe969c1208` |
| `backup/ubuntu-20261024/history/fixtures/SvelteKit_Node_MySQL` | `ed045f138aa5cb2b96e7c2ea64e4a698b7663aef` |
| `backup/ubuntu-20261024/history/fixtures/SvelteKit_Static_Express_PostgreSQL` | `c0f574a7ee6f383fcad3d6d3cc27c8449bc106df` |
| `backup/ubuntu-20261024/history/fixtures/Vite_React_Express_PostgreSQL` | `50e52440dade96b48c51d635442a5cec273847b4` |
| `backup/ubuntu-20261024/history/fixtures/Vite_Vue_Fastify_MySQL` | `5b27500d9658c25f508b67ed6c5a56467b970a14` |
| `backup/ubuntu-20261024/history/fixtures/Webpack_React_Fastify_MongoDB` | `8d50e3757134f87bf380bc068f52eeb0b48c2b6b` |
| `backup/ubuntu-20261024/history/fixtures/main` | `41ae8b0c9f60e600357fa4a54bae712d0dc6725f` |
| `backup/ubuntu-20261024/history/m0-checkout/codex/m0-workflow-identity-20261010` | `a96d36e33cf0d70ec731e76ffc4e9f8aa1030b56` |
| `backup/ubuntu-20261024/history/mainrepo/codex/fix-generation-efs-token` | `9f778e131d099eff6be4e9f17f84bee6d9c333a1` |
| `backup/ubuntu-20261024/history/mainrepo/codex/fix-terraform-formatting` | `23b202e17ac3630424b967d961c447a1ee264e45` |
| `backup/ubuntu-20261024/history/mainrepo/codex/m0-workflow-identity-20261010` | `95257d05f6758c03acd3e41105d2717704ea84ef` |
| `backup/ubuntu-20261024/history/mainrepo/codex/publish-final-generation-invariants` | `d76309ab54403608ae06c14c1a400bf00a4943ce` |
| `backup/ubuntu-20261024/history/mainrepo/codex/publish-generation-lifecycle` | `df620aac9c43e643f36d67b9a007a07fd7a4d13e` |
| `backup/ubuntu-20261024/history/mainrepo/codex/publish-managed-database-reconciliation` | `d150c4369389fe24c87e42e041e710d8bbe7b4b7` |
| `backup/ubuntu-20261024/history/mainrepo/codex/publish-rollback-generation-guard` | `446a72ec3364acc3f1a128e065e0d205e911e7ab` |
| `backup/ubuntu-20261024/history/mainrepo/codex/state-aware-deployment-recovery` | `521f045d438fead7d596b56f1b3a5cfe8d37f316` |
| `backup/ubuntu-20261024/history/mainrepo/container-setup-local-preserved` | `2d4e900b723e5781ef782d02710bcba100b5fdb4` |
| `backup/ubuntu-20261024/history/mainrepo/final-container-setup` | `ce6dc8cdc81f5773a94f4cfb96d0089d8f14e3be` |
| `backup/ubuntu-20261024/history/mainrepo/master` | `49681d4570f5943be26e310600a4d92557b58f13` |
| `backup/ubuntu-20261024/history/mainrepo/safety/detection-readiness-20260827` | `0b50984c5d79bf490e3135a6d8fa9f71f966a525` |
| `backup/ubuntu-20261024/history/mainrepo/stash` | `a8ce8090c32ba5ce3801751932cd958b531ffaea` |
| `backup/ubuntu-20261024/history/recovered/078458fa758d` | `76c3fb9bd199f911f362cbbe60733c69288c55e3` |
| `backup/ubuntu-20261024/history/recovered/23c5e8687b78` | `ca0326a3675c1439401166ab82de6e5611663d94` |
| `backup/ubuntu-20261024/history/recovered/29370942acec` | `2cdefa283cd40347c4d91f23572640246891f50b` |
| `backup/ubuntu-20261024/history/recovered/6a22c385d4dd` | `46cd54bb5119a3aa93e40680ad847755e3be89fa` |
| `backup/ubuntu-20261024/history/recovered/70fad60bc805` | `4acbfc94bc5725df6cd3ab596f797199e65c82ea` |
| `backup/ubuntu-20261024/history/recovered/7789122b21a5` | `57aa3ee56a578671e5914aa4cdc23ab1775116fd` |
| `backup/ubuntu-20261024/history/recovered/870912fbe35c` | `7cf3224c586792340d3ba329046555ee56dea6e1` |
| `backup/ubuntu-20261024/history/recovered/9489b0541685` | `576f2b30373293bfd187add35a6af0836e7a2725` |
| `backup/ubuntu-20261024/history/recovered/a37493a54094` | `a37493a5409418a63efa1effc459534320f3ce24` |
| `backup/ubuntu-20261024/history/recovered/b7929ba1eb7f` | `b7929ba1eb7f66577c004f8e4c719dbdab7b4be9` |
| `backup/ubuntu-20261024/history/recovered/c1624dc24e5f` | `a6b8dde1160a6e90a9610a66ac0843b68fa5f2d4` |
| `backup/ubuntu-20261024/history/recovered/c35b2f9ea1b2` | `acbd15d3c68bedafcd148dfb00b8bdc7d594ff95` |
| `backup/ubuntu-20261024/history/recovered/d3a104fc8cc9` | `70ac1ef922db6fb7274ad5a1f5a8b2afb6660aed` |
| `backup/ubuntu-20261024/history/recovered/e76e16c79f22` | `26f1700d503eaae73479f476d159ac6bd3cf6cc3` |
| `backup/ubuntu-20261024/history/recovered/ebbd38fcb5c0` | `11e6c6355f283fb5fd43f1d596d12bbe64a68141` |
| `backup/ubuntu-20261024/history/release1/main` | `d77f1b869bef73713475a331d4d45383e527a456` |
| `backup/ubuntu-20261024/history/team-runtime/main` | `565d9ab8ea5aed6db9a19dddb7cad800c3b346d6` |
| `backup/ubuntu-20261024/m0-security-working-tree` | `c1ee14c21b594606d76d9397fac680507b4825aa` |
| `backup/ubuntu-20261024/release1-working-tree` | `e810a79e3d3685ee4c7835f6397c8ecc07184c9f` |
| `backup/ubuntu-20261024/source-assets` | `8039c0e5f4d21faf2e33dbba51ae55963c82c3c7` |
| `backup/ubuntu-20261024/version1-local-deletions` | `e716ebfa007c4ba3e37a32dbc97b66c3565c7814` |
