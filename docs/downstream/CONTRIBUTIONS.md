# Contribution assessment — 2026-09-10

## Already proposed

- Arkcli provider discovery/quota mapping and desktop source labels: [TokenMonitor #655](https://github.com/Javis603/token-monitor/pull/655). Runtime cherry-picks have different commit IDs but the provider implementation matches the contribution branch. Do not submit twice.
- Optional Web dashboard/authentication/PWA: [TokenMonitor #656](https://github.com/Javis603/token-monitor/pull/656). Keep deployment-specific branch documentation/configuration out of this PR.

## Hub persistence scheduler: removed

Decision at 19:35: remove the downstream scheduler and restore upstream Node Hub writes. Measurements did not justify its additional configuration, retry/reentrancy lifecycle and acknowledged-update crash window. Hub implementation, tests, build-manifest inputs and operator docs now match upstream; archive branches and historical release tags preserve the prior code. No persistence PR is planned. Production still uses its existing checkout until a separately authorized rollout.

## OpenClaw SQLite and embedded Codex homes: coordinate with Tokscale

Local commits `3c01b79` and `223b744` add read-only usage metadata projection, mirror exclusion and embedded Codex-home scanning. The generic need is real, but a second long-lived parser in TokenMonitor is not the preferred upstream architecture.

Checked upstream Tokscale source: release `v4.15.1` lacks `transcript_events` and `codex-home` handling in `crates/tokscale-core/src/sessions/openclaw.rs`; current `main` includes both. [Tokscale #1312](https://github.com/junhoyeo/tokscale/pull/1312) adds per-profile Codex rollout handling. The latest published release at assessment time remains `v4.15.1`. Therefore keep the opt-in compatibility adapter temporarily, and compare the next supported Tokscale release against anonymized fixtures before removing it. Do not turn it on alongside overlapping native accounting without checking deduplication.

Current local adapter limitations include fixed default OpenClaw directory/schema assumptions, synchronous database/file scans, incomplete malformed-schema/date coverage, an observation-file single-writer contract. New upstream work should target gaps after checking Tokscale coverage, not copy this local adapter wholesale.

## Hermes calendar attribution: keep local pending a source contract

The adapter improves model attribution and avoids assigning an entire old session to today, but historical per-call times are unavailable. Observed deltas, counter resets, missed samples and midnight crossings can conservatively undercount. The source already has a maintained Hermes SQLite parser in Tokscale. Contributions should focus there on model/counter/source contracts and explicit completeness semantics; TokenMonitor must not label reconstructed calendar totals exact. Keep the current opt-in flag and local operational notes until this is resolved.

## Codex activity and noninteractive quota probe

Decision at 19:26: remove the token-only activity override and its cache/tail scanner. Keep the existing TokenMonitor/Tokscale session-activity semantics; no separate activity contribution is planned. Hermes observation accounting is retained unchanged.

The old `df152d8` change from approval `untrusted` to `never` is already present in upstream's extracted `src/shared/providers/codex/limits.js`. The redundant downstream flag test has now been removed by restoring that test file from current upstream. Historical ancestry remains, but there is no distinct implementation to contribute again.

## Deployment-only

Release records, local archive branches, CI branch selectors, credential references, provider enablement, shared-state migration choices and service paths belong to the downstream fork/IaC. Never include real account data, credentials, host screenshots or runtime SQLite files in contribution branches.

## Follow-up review

See [the source/community and I/O review](REVIEW-2026-09-10.md). The persistence proposal is now lower priority: measured local I/O does not demonstrate disk damage or a user-visible performance problem. The initial candidate's remote CI exposed a timezone-specific test fixture; the follow-up uses local calendar midnight and verifies UTC, Shanghai and Los Angeles. Do not treat the original candidate tag as fully cross-platform verified.
