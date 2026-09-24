import type { SessionSandbox } from './sandbox-adapter';

export type CodexSnapshot = {
  bootId: string;
  active: null | {
    runId: string;
    threadId: string;
    status: string;
    error?: string;
  };
  events: { seq: number; kind: string; content: string; createdAt: string }[];
  approvals: { id: string; method: string; command: string; reason: string }[];
  tools: { id: string; tool: string; arguments: Record<string, string> }[];
};

// The bridge owns the app-server JSON-RPC handshake and notifications. The DO
// sees only this small protocol; neither JSON-RPC nor Sandbox APIs leak into
// the task state machine.
export class CodexAdapter {
  constructor(private sandbox: SessionSandbox) {}
  credentials(value?: string) {
    return this.sandbox.bridge<{ credentials: string | null }>(
      '/credentials',
      value === undefined ? undefined : { credentials: value },
    );
  }
  startTurn(input: {
    runId: string;
    threadId: string | null;
    prompt: string;
    model: string | null;
    hasRepo: boolean;
    dynamicTools: unknown[];
  }) {
    return this.sandbox.bridge<{ threadId: string; bootId: string }>(
      '/run',
      input,
    );
  }
  ensureThread(input: {
    threadId: string | null;
    model: string | null;
    hasRepo: boolean;
    dynamicTools: unknown[];
  }) {
    return this.sandbox.bridge<{ threadId: string; bootId: string }>(
      '/thread',
      input,
    );
  }
  state(ack?: number) {
    return this.sandbox.bridge<CodexSnapshot>('/state', { ack });
  }
  approve(id: string, decision: string, runId: string) {
    return this.sandbox.bridge('/approve', { id, decision, runId });
  }
  toolResult(
    id: string,
    runId: string,
    result: { text: string; success: boolean },
  ) {
    return this.sandbox.bridge('/tool-result', { id, runId, ...result });
  }
  cancel(runId: string) {
    return this.sandbox.bridge('/cancel', { runId });
  }
  finish(runId: string) {
    return this.sandbox.bridge('/finish', { runId });
  }
  checkpoint() {
    return this.sandbox.bridge('/checkpoint');
  }
}
