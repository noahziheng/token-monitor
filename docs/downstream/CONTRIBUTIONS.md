# Contribution assessment — 2026-09-10

## Already proposed

- Arkcli provider discovery/quota mapping and desktop source labels: [TokenMonitor #655](https://github.com/Javis603/token-monitor/pull/655). Runtime cherry-picks have different commit IDs but the provider implementation matches the contribution branch. Do not submit twice.
- Optional Web dashboard/authentication/PWA: [TokenMonitor #656](https://github.com/Javis603/token-monitor/pull/656). Keep deployment-specific branch documentation/configuration out of this PR.

## Hub persistence scheduler: suitable as a separate proposal

Local commits `70ed91f` through `b325d2f`, retained through merge `014c5b7`, introduce leading/trailing writes, forced flush for subscription/device changes, retry and shutdown handling. There is no host-specific dependency, and extensive fake-clock, reentrancy, failure and Hub integration tests exist. This can benefit high-frequency multi-device ingest.

Before proposing it, distill the implementation/tests/configuration into one focused branch from current upstream, excluding deployment plans and unrelated usage/arkcli/Web work. Explicitly discuss durability: the local default is 5000 ms, meaning acknowledged ingest can be lost on abrupt termination before flush. Prefer an opt-in interval with upstream's immediate-write default retained unless the maintainer accepts the changed durability contract. Confirm upstream Worker behavior remains unchanged and include write-count/latency measurements plus shutdown/failure tests. No new PR has been submitted by this assessment.

## OpenClaw SQLite and embedded Codex homes: coordinate with Tokscale

Local commits `3c01b79` and `223b744` add read-only usage metadata projection, mirror exclusion and embedded Codex-home scanning. The generic need is real, but a second long-lived parser in TokenMonitor is not the preferred upstream architecture.

Checked upstream Tokscale source: release `v4.15.1` lacks `transcript_events` and `codex-home` handling in `crates/tokscale-core/src/sessions/openclaw.rs`; current `main` includes both. [Tokscale #1312](https://github.com/junhoyeo/tokscale/pull/1312) adds per-profile Codex rollout handling. The latest published release at assessment time remains `v4.15.1`. Therefore keep the opt-in compatibility adapter temporarily, and compare the next supported Tokscale release against anonymized fixtures before removing it. Do not turn it on alongside overlapping native accounting without checking deduplication.

Current local adapter limitations include fixed default OpenClaw directory/schema assumptions, synchronous database/file scans, incomplete malformed-schema/date coverage, bounded-tail Codex activity extraction and an observation-file single-writer contract. New upstream work should target gaps after checking Tokscale coverage, not copy this local adapter wholesale.

## Hermes calendar attribution: keep local pending a source contract

The adapter improves model attribution and avoids assigning an entire old session to today, but historical per-call times are unavailable. Observed deltas, counter resets, missed samples and midnight crossings can conservatively undercount. The source already has a maintained Hermes SQLite parser in Tokscale. Contributions should focus there on model/counter/source contracts and explicit completeness semantics; TokenMonitor must not label reconstructed calendar totals exact. Keep the current opt-in flag and local operational notes until this is resolved.

## Codex activity and noninteractive quota probe

Actual token-event time is a generally useful session-activity fix, but the local 512 KiB tail scan should not become a second unbounded file-indexing subsystem. Compare against current Tokscale Codex session parsing and add narrowly scoped fixture tests there if the gap remains.

The old `df152d8` change from approval `untrusted` to `never` is already present in upstream's extracted `src/shared/providers/codex/limits.js`. The redundant downstream flag test has now been removed by restoring that test file from current upstream. Historical ancestry remains, but there is no distinct implementation to contribute again.

## Deployment-only

Release records, local archive branches, CI branch selectors, credential references, provider enablement, shared-state migration choices and service paths belong to the downstream fork/IaC. Never include real account data, credentials, host screenshots or runtime SQLite files in contribution branches.

## Follow-up review

See [the source/community and I/O review](REVIEW-2026-09-10.md). The persistence proposal is now lower priority: measured local I/O does not demonstrate disk damage or a user-visible performance problem. The initial candidate's remote CI exposed a timezone-specific test fixture; the follow-up uses local calendar midnight and verifies UTC, Shanghai and Los Angeles. Do not treat the original candidate tag as fully cross-platform verified.
