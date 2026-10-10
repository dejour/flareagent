import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
let source = await readFile('runtime/container/bridge.mjs', 'utf8');
// Exercise the real request handler without starting a server or subprocesses.
source = source.slice(0, source.indexOf('let serial = Promise.resolve();'));
source =
  source.slice(0, source.indexOf("process.on('uncaughtException'")) +
  source.slice(source.indexOf('let engine,'));
source += `\nexport {handle,stopEngine}; export function seedExited(){engine={pid:1,exitCode:null,signalCode:"SIGTERM",once(){throw Error("already exited")}};ready=Promise.resolve()} export function seed(status){active={runId:'run',threadId:'thread',status};tools.clear();tools.set('tool',{rpcId:1,tool:'github_push'});let writes=[];engine={stdin:{write:x=>writes.push(x)}};return {active,writes,tools};}`;
process.env.BRIDGE_SECRET = 'test-only';
const { handle, seed, stopEngine, seedExited } = await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
);
for (const status of ['completed', 'cancelled', 'failed', 'needs_attention']) {
  test(`a late tool result cannot reactivate a ${status} turn`, async () => {
    const state = seed(status);
    await handle(new URL('http://bridge/tool-result'), {
      runId: 'run',
      id: 'tool',
      text: 'done',
      success: true,
    });
    assert.equal(state.active.status, status);
    assert.equal(state.writes.length, 0);
  });
}
test('a tool response does not undo a cancellation in progress', async () => {
  const state = seed('cancelling');
  await handle(new URL('http://bridge/tool-result'), {
    runId: 'run',
    id: 'tool',
    text: 'done',
    success: true,
  });
  assert.equal(state.active.status, 'cancelling');
  assert.equal(state.writes.length, 1);
});

test('stopping an already signal-terminated engine does not await a second exit', async () => {
  seedExited();
  await stopEngine();
  await stopEngine();
});
