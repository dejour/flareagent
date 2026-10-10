import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const output = await build({
  entryPoints: ['runtime/session.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'cloudflare-test',
      setup(build) {
        build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
          path: 'workers',
          namespace: 'fake',
        }));
        build.onResolve({ filter: /^@cloudflare\/sandbox$/ }, () => ({
          path: 'sandbox',
          namespace: 'fake',
        }));
        build.onLoad({ filter: /.*/, namespace: 'fake' }, ({ path }) => ({
          contents:
            path === 'workers'
              ? 'export class DurableObject { constructor(ctx,env) {this.ctx=ctx;this.env=env} }'
              : 'export function getSandbox(){return {}}',
          loader: 'js',
        }));
      },
    },
  ],
});
const { SessionAgent } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(output.outputFiles[0].text).toString('base64')
);
function fixture() {
  const session = {
    sessionId: 'task',
    userId: 'alice',
    sandboxId: 'task',
    repo: null,
    codexThreadId: 'thread',
    currentRun: {
      id: 'run',
      bootId: 'boot',
      ack: 0,
      inputCount: 1,
      startedAt: Date.now(),
      dispatched: true,
    },
    status: 'running',
    baseCommit: '0'.repeat(40),
    latestCheckpointKey: null,
    consumedMessages: 0,
    operationState: {},
    threadStarted: true,
  };
  const values = new Map([['session', structuredClone(session)]]);
  const storage = {
    get: async (k) => structuredClone(values.get(k)),
    put: async (k, v) => values.set(k, structuredClone(v)),
    delete: async (k) => {
      for (const x of Array.isArray(k) ? k : [k]) values.delete(x);
    },
    setAlarm: async (t) => values.set('alarm', t),
    deleteAlarm: async () => values.delete('alarm'),
    list: async ({ prefix }) =>
      new Map([...values].filter(([k]) => k.startsWith(prefix))),
  };
  const statement = {
    bind() {
      return this;
    },
    run: async () => ({}),
    first: async () => null,
    all: async () => ({ results: [] }),
  };
  const agent = new SessionAgent(
    { storage },
    { DB: { prepare: () => statement, batch: async () => [] } },
  );
  return { agent, values, session, storage };
}
test('a transient polling failure retains the dispatched run and retries monitoring', async () => {
  const { agent, values } = fixture();
  let calls = 0;
  agent.poll = async () => {
    if (++calls === 1) {
      const e = new Error('temporary transport failure');
      e.stack = e.message;
      throw e;
    }
  };
  await agent.alarm();
  assert.equal(values.get('session').currentRun.id, 'run');
  assert.ok(values.has('alarm'));
  await agent.alarm();
  assert.equal(calls, 2);
});
test('terminal snapshots do not execute stale GitHub requests', async () => {
  const { agent, session } = fixture();
  let finishes = 0;
  agent.codex = () => ({
    state: async () => ({
      bootId: 'boot',
      active: { runId: 'run', status: 'completed' },
      events: [],
      tools: [{ id: 'tool', tool: 'github_push' }],
      approvals: [],
    }),
  });
  agent.resolveTool = async () => assert.fail('a completed turn must not push');
  agent.finish = async () => finishes++;
  await agent.poll(session);
  assert.equal(finishes, 1);
});
test('retrying result delivery never repeats a GitHub push', async () => {
  const { agent, session } = fixture();
  let pushes = 0,
    deliveries = 0;
  agent.task = async () => ({ project_id: 'repo' });
  agent.project = async () => ({
    github_repo_id: 1,
    github_installation_id: 2,
  });
  agent.account = () => ({
    sessionRepository: async () => ({
      repo: { full_name: 'alice/repo' },
      token: 'test',
    }),
  });
  agent.box = () => ({
    push: async () => {
      pushes++;
      return { ok: true };
    },
  });
  agent.codex = () => ({
    toolResult: async () => {
      if (++deliveries === 1) throw new Error('reply lost');
    },
  });
  const tool = {
    id: 'tool',
    tool: 'github_push',
    arguments: { branch: 'flareagent/fix' },
  };
  await assert.rejects(agent.resolveTool(session, tool), /reply lost/);
  await agent.resolveTool(session, tool);
  assert.equal(pushes, 1);
  assert.equal(deliveries, 2);
});
test('a new run stops and checkpoints the old run before it can proceed', async () => {
  const { agent, session } = fixture();
  const order = [];
  session.currentRun.id = 'new';
  agent.codex = () => ({
    state: async () => ({
      bootId: 'boot',
      active: { runId: 'old', threadId: 'thread' },
      events: [],
    }),
    retire: async (id) => order.push('stop:' + id),
    credentials: async () => ({ credentials: null }),
    checkpoint: async () => order.push('freeze'),
  });
  agent.checkpoint = async () => {
    order.push('save');
    return 'backup';
  };
  await agent.retirePrevious(session, {});
  assert.deepEqual(order, ['stop:old', 'freeze', 'save']);
  assert.equal(session.codexThreadId, 'thread');
  assert.equal(session.currentRun.id, 'new');
});
test('persistent transport failures retain diagnostics and the interrupted run', async () => {
  const { agent, values } = fixture();
  agent.poll = async () => {
    const e = new Error('offline');
    e.stack = e.message;
    throw e;
  };
  for (let i = 0; i < 6; i++) await agent.alarm();
  assert.equal(values.get('session').status, 'needs_attention');
  assert.equal(values.get('session').interruptedRun.id, 'run');
  assert.equal(values.get('failureHistory').length, 6);
  assert.equal(values.has('alarm'), false);
});
test('an exited engine cannot trigger outstanding GitHub requests', async () => {
  const { agent, session } = fixture();
  agent.codex = () => ({
    state: async () => ({
      bootId: 'boot',
      active: { runId: 'run', status: 'needs_attention' },
      events: [],
      tools: [{ id: 'tool', tool: 'github_push' }],
      approvals: [],
    }),
  });
  agent.resolveTool = async () => assert.fail('an exited engine must not push');
  await agent.poll(session);
  assert.equal(session.status, 'needs_attention');
  assert.equal(session.interruptedRun.id, 'run');
});
test('a cancellation request is handled before outstanding external writes', async () => {
  const { agent, session } = fixture();
  let cancellations = 0;
  session.currentRun.stoppingAt = Date.now();
  agent.codex = () => ({
    state: async () => ({
      bootId: 'boot',
      active: { runId: 'run', status: 'running' },
      events: [],
      tools: [{ id: 'tool', tool: 'github_push' }],
      approvals: [],
    }),
    cancel: async () => cancellations++,
  });
  agent.resolveTool = async () => assert.fail('a stopping turn must not push');
  await agent.poll(session);
  assert.equal(cancellations, 1);
});
