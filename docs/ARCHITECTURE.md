# FlareAgent execution architecture

Updated 2026-09-20. This is the compact checkpoint design used by new sessions.

```mermaid
flowchart TD
  UI[Web UI] -->|SSE / JSON| W[Web Worker]
  W --> R[Runtime Worker]
  R --> S[SessionAgent Durable Object, one per task]
  S --> B[Cloudflare Sandbox, one per session]
  B --> C[Codex app-server]
  B --> G[/workspace/repo]
  S --> D[D1: task index and events]
  S --> H[AccountAgent: encrypted credentials]
  S -->|compact checkpoint key| R2[R2: session changes and Codex rollouts]
  G -. clone recorded base commit .-> GH[GitHub]
```

The task ID is the SessionAgent ID and Sandbox ID. One session has one Codex thread and at most one mutating turn. `cancel` stops a turn without deleting the session. The Codex app-server owns the coding loop; the SessionAgent owns scheduling, run fencing, GitHub operation idempotency, and checkpoint pointers.

The Sandbox is disposable. While it is alive, subsequent turns reuse its independent repository and dependencies. After a completed turn, the bridge stops Codex and removes `auth.json`. A checkpoint stores only the original Git commit ID, local Git commits beyond that commit, staged and unstaged patches, non-ignored untracked files, and Codex rollout files. The latest completed checkpoint replaces the preceding one in R2. A new session does not produce or use a prepared base snapshot.

If the Sandbox disappears, the SessionAgent clones the authorized GitHub repository, checks out the recorded base commit, restores the checkpoint, starts Codex, and resumes the same thread. Dependencies and dev servers are recreated when the work requires them. Cold recovery can therefore be slower than restoring a full workspace. The recorded commit must remain fetchable from GitHub; a force push, repository deletion, or revoked access can prevent recovery. Ignored files, dependency directories, build outputs, process state, and caches are deliberately not checkpointed. The archive has an 80 MiB uncompressed limit.

An interrupted active turn is never automatically replayed because it may have pushed code or performed another external side effect. GitHub write operations record dispatch before the call; uncertain outcomes require inspection before another attempt. Work created after the latest completed checkpoint can be lost if the Sandbox fails during a turn. Existing sessions with an old Sandbox directory backup can still restore it and migrate to a compact checkpoint after their next completed turn.

Account login uses an account-scoped Sandbox with the same image as coding sessions. It starts a short-lived Codex bridge for device authorization and model discovery, saves encrypted credentials in AccountAgent, and is destroyed after use. Coding sessions retain their own isolated Sandbox IDs.

## References

- [Cloudflare Sandbox lifecycle](https://developers.cloudflare.com/sandbox/concepts/sandboxes/)
- [Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [R2 Worker bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Codex app-server protocol](https://developers.openai.com/docs/app-server)
