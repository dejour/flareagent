import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal } from '../runtime/crypto.ts';

test('encrypted credentials reject tampering and a different owner', async () => {
  const secret = 'a'.repeat(64);
  const input = new TextEncoder().encode('private credential').buffer;
  const sealed = await seal(secret, 'alice', input);
  assert.deepEqual(await unseal(secret, 'alice', sealed.buffer), input);
  await assert.rejects(unseal(secret, 'bob', sealed.buffer));
  sealed[15] ^= 1;
  await assert.rejects(unseal(secret, 'alice', sealed.buffer));
});
