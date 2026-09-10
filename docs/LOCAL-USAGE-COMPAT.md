# Local SQLite usage compatibility

Deployment baseline: upstream Token Monitor 0.55.0, bdeffba; Tokscale 4.15.1.
Enable with `TOKEN_MONITOR_LOCAL_SQLITE_USAGE=1` on the headless agent.

- Native Codex uses the configured Codex home (normally ~/.codex).
- OpenClaw discovers each agent's `agent/codex-home` and attributes those
  rollouts to OpenClaw. Codex mirror events are excluded from the read-only
  SQLite transcript accounting to avoid counting the same call twice.
- SQLite projects usage metadata only, not message contents. Legacy JSONL
  session rows present in SQLite are replaced by the authoritative DB rows.
- Hermes reads session_model_usage model identities, not the session's last
  selected model. Calendar periods include buckets first observed within that
  period plus observed cumulative deltas for older buckets. It does not move
  the entire lifetime value of an old session into today.
- Hermes's historical database has no per-call timestamps/counts. Unobserved
  portions of cross-day usage cannot be reconstructed exactly. The Web must
  label calendar totals partial. Lifetime totals remain the upstream report.
- Observation checkpoints contain hashed identities and numeric counters only,
  are mode 0600, and live under TOKEN_MONITOR_SHARED_DIR. Keep one writer.
- A counter reset or a sample crossing midnight is not assigned a fabricated
  per-day delta. These cases can leave a conservative undercount.
- This deployment uses a fresh shared state directory. Existing session
  archives are migrated with lifetime snapshots only, using the existing
  per-client/session deduplication; old today/month snapshots are not reused.
  Graph history is disabled until its calendar attribution supports these
  sources. Original archives remain untouched for recovery.

The adapter is opt-in and targets the local SQLite schemas verified here.
Schema/read errors fail the scan rather than silently presenting a zero.
