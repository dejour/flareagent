import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const output = await build({
  entryPoints: ['runtime/github.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const { GitHubConnection } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(output.outputFiles[0].text).toString('base64')
);
test('GitHub OAuth binds state to owner, seals credentials, and checks installation repo access', async () => {
  const values = new Map();
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => values.set(key, value),
    delete: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    },
  };
  const env = {
    GITHUB_CLIENT_ID: 'client',
    GITHUB_CLIENT_SECRET: 'private',
    GITHUB_APP_SLUG: 'test',
    PUBLIC_ORIGIN: 'https://example.test',
    CREDENTIAL_KEY: 'b'.repeat(64),
  };
  const github = new GitHubConnection(env, storage, 'alice');
  let called = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    called++;
    if (String(url).includes('/login/oauth/access_token'))
      return Response.json({
        access_token: 'never-expose-token',
        refresh_token: 'never-expose-refresh',
        expires_in: 3600,
      });
    assert.equal(init.headers.authorization, 'Bearer never-expose-token');
    if (String(url).endsWith('/user')) return Response.json({ login: 'alice' });
    if (String(url).includes('/user/installations/9/repositories'))
      return Response.json({
        repositories: [
          {
            id: 42,
            full_name: 'alice/repo',
            default_branch: 'main',
            permissions: { push: true },
          },
        ],
      });
    if (String(url).includes('/user/installations?'))
      return Response.json({ installations: [{ id: 9 }] });
    throw new Error('Unexpected request');
  };
  try {
    assert.equal((await github.status()).connected, false);
    const { url } = await github.begin();
    const state = new URL(url).searchParams.get('state');
    await assert.rejects(github.complete('code', 'forged'));
    assert.equal(called, 0);
    await github.complete('code', state);
    await assert.rejects(github.complete('code', state));
    assert.equal((await github.status()).connected, true);
    assert.equal(
      new TextDecoder()
        .decode(values.get('githubTokens'))
        .includes('never-expose'),
      false,
    );
    assert.equal(
      JSON.stringify(await github.status()).includes('never-expose'),
      false,
    );
    assert.equal((await github.authorize(42, 9)).full_name, 'alice/repo');
    await assert.rejects(github.authorize(42, 10));
    await assert.rejects(github.authorize(43, 9));
    const bob = new GitHubConnection(env, storage, 'bob');
    await assert.rejects(bob.repositories());
    await github.disconnect();
    assert.equal((await github.status()).connected, false);
    await assert.rejects(github.repositories());
  } finally {
    globalThis.fetch = originalFetch;
  }
});
