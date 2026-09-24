import {
  getSandbox,
  type DirectoryBackup,
  type Sandbox,
} from '@cloudflare/sandbox';

export type WorkspaceBackup = DirectoryBackup;
export type SandboxEnv = {
  SANDBOXES: DurableObjectNamespace<Sandbox>;
  BRIDGE_SECRET: string;
};

// All container SDK calls stay behind this adapter. A sandbox ID is
// a session ID, never a project ID; no worktree is shared between sessions.
export class SessionSandbox {
  private sandbox: Sandbox;
  constructor(
    private env: SandboxEnv,
    readonly id: string,
  ) {
    this.sandbox = getSandbox(env.SANDBOXES, id, {
      sleepAfter: '10m',
      enableDefaultSession: false,
    });
  }
  async alive() {
    const result = await this.sandbox.exec(
      'test -f /workspace/.cloudagent-session && cat /workspace/.cloudagent-session',
    );
    return result.exitCode === 0 && result.stdout.trim() === this.id;
  }
  async prepare() {
    await this.sandbox.exec(
      'mkdir -p /workspace/.codex && chown 1000:1000 /workspace /workspace/.codex',
    );
  }
  async mark() {
    await this.prepare();
    await this.sandbox.writeFile('/workspace/.cloudagent-session', this.id);
  }
  async restore(handle: WorkspaceBackup) {
    await this.sandbox.restoreBackup(handle);
  }
  async exportChanges(base: string): Promise<ArrayBuffer> {
    const response = await this.sandbox.containerFetch(
      new Request(`http://localhost/session-snapshot?base=${encodeURIComponent(base)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.env.BRIDGE_SECRET}` },
      }),
      8081,
    );
    if (!response.ok) throw new Error('Session checkpoint failed');
    return response.arrayBuffer();
  }
  async importChanges(base: string, archive: ArrayBuffer): Promise<void> {
    const response = await this.sandbox.containerFetch(
      new Request(`http://localhost/session-restore?base=${encodeURIComponent(base)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.env.BRIDGE_SECRET}` },
        body: archive,
      }),
      8081,
    );
    if (!response.ok) throw new Error('Session restore failed');
  }
  async bridge<T = Record<string, unknown>>(
    bodyPath: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.sandbox.containerFetch(
      new Request(`http://localhost${bodyPath}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.env.BRIDGE_SECRET}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      8081,
    );
    const data = await response
      .json<{ error?: string } & T>()
      .catch(() => ({}) as { error?: string } & T);
    if (!response.ok)
      throw new Error(data.error || `Codex bridge (${response.status})`);
    return data;
  }
  async startBridge() {
    const running = await this.sandbox.exec(
      "pgrep -f '^node /opt/cloudagent/bridge.mjs$' >/dev/null",
    );
    if (running.success) {
      try {
        return await this.bridge('/health');
      } catch {
        /* restart */
      }
    }
    await this.sandbox.startProcess('node /opt/cloudagent/bridge.mjs', {
      env: {
        BRIDGE_SECRET: this.env.BRIDGE_SECRET,
        BRIDGE_PORT: '8081',
        CODEX_HOME: '/workspace/.codex',
      },
    });
    for (let i = 0; i < 30; i++) {
      try {
        return await this.bridge('/health');
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error('Codex app-server did not start');
  }
  async clone(repo: string, token: string, base?: string) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository');
    if (base && !/^[0-9a-f]{40,64}$/.test(base)) throw new Error('Invalid base commit');
    // The installation token is used before Codex starts; no token is saved in
    // the repository or backup. Git never puts it in the remote URL.
    const command = `git -c credential.helper='!f() { echo username=x-access-token; echo password="$GITHUB_TOKEN"; }; f' clone --depth 1 https://github.com/${repo}.git /workspace/repo`;
    const result = await this.sandbox.exec(command, {
      env: { GITHUB_TOKEN: token },
      timeout: 180000,
    });
    if (result.exitCode !== 0) throw new Error('GitHub clone failed');
    const head = await this.sandbox.exec('git rev-parse HEAD', {
      cwd: '/workspace/repo',
    });
    if (head.exitCode !== 0) throw new Error('Cannot read repository commit');
    if (base && head.stdout.trim() !== base) {
      const fetch = await this.sandbox.exec(
        `git -c credential.helper='!f() { echo username=x-access-token; echo password="$GITHUB_TOKEN"; }; f' fetch --depth 1 origin ${base} && git checkout --detach ${base}`,
        { cwd: '/workspace/repo', env: { GITHUB_TOKEN: token }, timeout: 180000 },
      );
      if (fetch.exitCode !== 0) throw new Error('Recorded GitHub commit is unavailable');
    }
    await this.sandbox.exec('chown -R 1000:1000 /workspace/repo');
    await this.sandbox.exec(
      'git config user.name FlareAgent && git config user.email flareagent@localhost',
      { cwd: '/workspace/repo' },
    );
    return base || head.stdout.trim();
  }
  async baseCommit() {
    const result = await this.sandbox.exec('git -c safe.directory=/workspace/repo rev-parse refs/remotes/origin/HEAD', {
      cwd: '/workspace/repo',
    });
    if (result.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(result.stdout.trim()))
      throw new Error('Cannot identify the repository base commit');
    return result.stdout.trim();
  }
  async push(repo: string, token: string, branch: string) {
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
      !/^(?:flareagent|cloudagent)\/[\w-]+$/.test(branch)
    )
      throw new Error('Invalid repository or branch');
    const command = `git -c safe.directory=/workspace/repo -c credential.helper='!f() { echo username=x-access-token; echo password="$GITHUB_TOKEN"; }; f' push https://github.com/${repo}.git refs/heads/${branch}:refs/heads/${branch}`;
    const result = await this.sandbox.exec(command, {
      cwd: '/workspace/repo',
      env: { GITHUB_TOKEN: token },
      timeout: 180000,
    });
    if (result.exitCode !== 0)
      throw new Error(
        `GitHub push failed: ${result.stderr.replaceAll(token, '[redacted]').slice(0, 500) || `exit ${result.exitCode}`}`,
      );
    return { ok: true };
  }
  async destroy() {
    await this.sandbox.destroy();
  }
}
