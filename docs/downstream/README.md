# Downstream integration and releases

This directory belongs to the fork deployment branch, not the upstream feature PRs.

## Branch ownership

- `upstream/main`: mirror of the upstream main branch; no local patches.
- `archive/local-runtime-20260910`: exact saved Hub/agent source checkout at `d145ce6`; never rewrite this backup.
- `deploy/noah`: integration of upstream plus required unmerged patches, with CI on push. This is the source for future unified releases, not an instruction to deploy every push.
- `feat/volcengine-arkcli`: isolated contribution for upstream PR #655.
- Fork `main`: currently the source of upstream Web PR #656; leave it intact while that PR is open. Do not merge deployment-only changes into it.
- `fix/web-pr656-review`: isolated Web review worktree; changes go to the existing Web PR, then enter `deploy/noah` through an explicit integration merge.

## Release procedure

1. Fetch upstream and each approved contribution branch. Work outside active service directories. Keep archive and published release tags immutable; use forward merges instead of force-pushing.
2. Merge upstream, then outstanding contributions into `deploy/noah`. For an already merged PR, use upstream's implementation and remove only genuinely superseded patches after comparing behavior; do not blindly cherry-pick duplicate patches.
3. Run `npm ci --ignore-scripts`, `npm ci --prefix web --ignore-scripts`, `npm run update:hub-build`, `npm run verify`, `npm run web:verify`, and `npm run web:build`. Runtime native dependency setup must also follow upstream `ensure:tokscale` before an agent release is activated.
4. Add an immutable record under `releases/`, including exact source parents, verification, artifact hashes, rollout state and known limitations. Tag it `noah-YYYYMMDD.N-rcN` until rollout is accepted. These tags intentionally do not match upstream's `v*` publishing trigger.
5. Stage a fixed-commit release directory on disk, with separate dependencies/build outputs. Keep credentials, runtime databases and device identity outside it; supply protected config through IaC. Do not bundle a working `.env`, auth state, data directory or offline snapshot.
6. Update IaC to pin the release commit and point services at that release directory. Preserve provider configuration, OIDC public origin, data paths and checkpoint ownership. Activate components only under the deployment's authorization rules. Hub and agent may be rolled separately, but their source release must be recorded independently if rollout is partial.
7. Verify authenticated UI/API, ingest, quota reporting and graceful Hub persistence. Record activation time and actually running version in a separate rollout receipt. A source checkout SHA or candidate tag alone is not proof of the running process version. Keep the prior release for rollback; never roll back accumulated data blindly.

## Initial candidate

`noah-20260910.1-rc1` integrates upstream `d897141`, saved runtime patches `d145ce6`, and Web `1cf3d36`. See the release JSON and contribution assessment. It has **not** replaced the current services. Existing Web/Hub/agent service directories remain unchanged; the fixed-release-directory/IaC switch is a subsequent rollout, not something this record claims has happened.

## Active release

`noah-20260910.1` was activated on 2026-09-10. All three services use fixed source commit `eb23c8f2e5ffbf01703746910a31196bee3ae086`; see [the rollout receipt](releases/noah-20260910.1.json). This replaces the earlier split deployment described in the immutable rc1 record. The runtime directory is separate from development worktrees. IaC pins this source commit and manages the service overrides; updating this branch does not deploy automatically.

The release tag also includes this documentation-only receipt; `sourceCommit` identifies the exact archived runtime source. Protected configuration and state remain external, with old credential-source paths retained until a deliberate configuration migration. Historical candidate tags/records remain unchanged.
