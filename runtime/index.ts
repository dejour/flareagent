import { DurableObject } from 'cloudflare:workers';
import { seal, unseal } from './crypto';
import { GitHubConnection, type GitHubEnv } from './github';
import { SessionSandbox, type SandboxEnv } from './sandbox-adapter';
import type { SessionAgent } from './session';

type Env = GitHubEnv & SandboxEnv & {
  DB: D1Database;
  ACCOUNTS: DurableObjectNamespace<AccountAgent>;
  SESSIONS: DurableObjectNamespace<SessionAgent>;
  CREDENTIAL_KEY: string;
};
type Connection = {
  status: 'disconnected' | 'connecting' | 'pending' | 'connected' | 'error';
  email?: string;
  verificationUrl?: string;
  userCode?: string;
  error?: string;
  startedAt?: number;
};
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

// Account state and encrypted credentials survive the short-lived login Sandbox.
// Coding sessions have different Sandbox IDs and never share this filesystem.
export class AccountAgent extends DurableObject<Env> {
  private serial: Promise<unknown> = Promise.resolve();
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.serial.then(fn);
    this.serial = result.catch(() => {});
    return result;
  }
  private async owner(): Promise<string> {
    return (await this.ctx.storage.get<string>('owner'))!;
  }
  private authBox(): SessionSandbox {
    // Sandbox IDs are limited to 63 characters; retain 58 hex digits of the DO ID.
    return new SessionSandbox(this.env, `auth-${this.ctx.id.toString().slice(0, 58)}`);
  }
  private async call<T>(path: string, body?: unknown): Promise<T> {
    const box = this.authBox();
    await box.prepare();
    await box.startBridge();
    return box.bridge<T>(path, body);
  }
  private async saveCredentials(): Promise<void> {
    const { credentials } = await this.call<{ credentials: string | null }>(
      '/credentials',
    );
    if (credentials)
      await this.sessionSaveCredentials(await this.owner(), credentials);
  }
  private async restoreCredentials(): Promise<void> {
    const owner = await this.owner();
    const credentials = await this.sessionCredentials(owner);
    await this.call('/credentials', { credentials });
  }
  private async tick(): Promise<void> {
    const connection = await this.ctx.storage.get<Connection>('connection');
    if (connection?.status === 'connecting') {
      const login = await this.call<{
        verificationUrl: string;
        userCode: string;
      }>('/login');
      if (new URL(login.verificationUrl).origin !== 'https://auth.openai.com')
        throw new Error('Invalid device login origin');
      await this.ctx.storage.put('connection', {
        status: 'pending',
        verificationUrl: login.verificationUrl,
        userCode: login.userCode,
        startedAt: Date.now(),
      } satisfies Connection);
    } else if (connection?.status === 'pending') {
      const info = await this.call<{
        account: { email?: string } | null;
        login: { status: string; error?: string } | null;
      }>('/account');
      if (info.account) {
        await this.saveCredentials();
        await this.authBox().destroy();
        await this.ctx.storage.put('connection', {
          status: 'connected',
          email: info.account.email,
        } satisfies Connection);
      } else if (
        Date.now() - (connection.startedAt || 0) > 10 * 60 * 1000 ||
        info.login?.status === 'error'
      ) {
        await this.authBox().destroy();
        await this.ctx.storage.put('connection', {
          status: 'error',
          error: '设备授权未完成或已过期，请重试。',
        } satisfies Connection);
      }
    }
    const latest = await this.ctx.storage.get<Connection>('connection');
    if (latest?.status === 'connecting' || latest?.status === 'pending')
      await this.ctx.storage.setAlarm(Date.now() + 5000);
    else await this.ctx.storage.deleteAlarm();
  }
  async sessionCredentials(owner: string): Promise<string> {
    if (owner !== (await this.owner())) throw new Error('Owner mismatch');
    const bytes = await this.ctx.storage.get<Uint8Array>('credentials');
    if (!bytes) throw new Error('请先连接 ChatGPT 账号。');
    return new TextDecoder().decode(
      await unseal(this.env.CREDENTIAL_KEY, owner, bytes.buffer as ArrayBuffer),
    );
  }
  async sessionSaveCredentials(
    owner: string,
    credentials: string,
  ): Promise<void> {
    if (owner !== (await this.owner()) || credentials.length > 65536)
      throw new Error('Owner mismatch');
    JSON.parse(credentials);
    await this.ctx.storage.put(
      'credentials',
      await seal(
        this.env.CREDENTIAL_KEY,
        owner,
        new TextEncoder().encode(credentials).buffer,
      ),
    );
  }
  async sessionRepository(
    owner: string,
    repoId: number,
    installationId: number,
  ) {
    if (owner !== (await this.owner())) throw new Error('Owner mismatch');
    return new GitHubConnection(
      this.env,
      this.ctx.storage,
      owner,
    ).gitCredential(repoId, installationId);
  }
  async sessionGitHubTool(
    owner: string,
    repoId: number,
    installationId: number,
    tool: string,
    args: Record<string, string>,
  ) {
    if (owner !== (await this.owner())) throw new Error('Owner mismatch');
    const github = new GitHubConnection(this.env, this.ctx.storage, owner);
    const repo = await github.authorize(repoId, installationId);
    if (tool === 'github_issues') return github.issues(repo);
    if (tool === 'github_create_pr') {
      if (
        ![args.head, args.base, args.title, args.body].every(
          (v) => typeof v === 'string',
        ) ||
        args.title.length > 256 ||
        args.body.length > 20000
      )
        throw new Error('Invalid PR');
      return github.createPR(
        repo,
        args as { head: string; base: string; title: string; body: string },
      );
    }
    throw new Error('Unknown GitHub tool');
  }
  async fetch(request: Request): Promise<Response> {
    return this.exclusive(async () => {
      const url = new URL(request.url);
      try {
        const owner = request.headers.get('x-owner');
        if (!owner || owner.length > 200)
          return json({ error: 'Missing identity' }, 401);
        const existing = await this.ctx.storage.get<string>('owner');
        if (existing && existing !== owner)
          return json({ error: 'Owner mismatch' }, 403);
        if (!existing) await this.ctx.storage.put('owner', owner);
        const body =
          request.method === 'GET'
            ? {}
            : await request.json<Record<string, string>>();
        const github = new GitHubConnection(this.env, this.ctx.storage, owner);
        if (url.pathname === '/github') {
          if (request.method === 'GET') return json(await github.status());
          if (request.method === 'DELETE')
            return json(await github.disconnect());
          return json(await github.begin());
        }
        if (url.pathname === '/github/callback')
          return json(await github.complete(body.code, body.state));
        if (url.pathname === '/github/repos')
          return json({ repositories: await github.repositories() });
        if (url.pathname === '/github/authorize')
          return json(
            await github.authorize(
              Number(body.repoId),
              Number(body.installationId),
            ),
          );
        const connection =
          (await this.ctx.storage.get<Connection>('connection')) ||
          ({ status: 'disconnected' } satisfies Connection);
        if (url.pathname === '/connection') {
          if (request.method === 'GET') return json(connection);
          if (request.method === 'DELETE') {
            await this.authBox().destroy();
            await this.ctx.storage.delete(['credentials', 'models']);
            await this.ctx.storage.put('connection', {
              status: 'disconnected',
            } satisfies Connection);
            await this.ctx.storage.deleteAlarm();
            await this.env.DB.prepare(
              "UPDATE tasks SET status='waiting_auth',updated_at=? WHERE owner_id=? AND status='queued'",
            )
              .bind(new Date().toISOString(), owner)
              .run();
            return json({ status: 'disconnected' });
          }
          if (connection.status === 'connected' || connection.status === 'pending')
            return json(connection);
          if (connection.status !== 'connecting') {
            await this.ctx.storage.delete('models');
            await this.ctx.storage.put('connection', {
              status: 'connecting',
              startedAt: Date.now(),
            } satisfies Connection);
          }
          await this.ctx.storage.put('failures', 0);
          await this.ctx.storage.setAlarm(Date.now() + 1000);
          try {
            await this.tick();
          } catch (error) {
            console.error(
              'Login probe failed',
              error instanceof Error ? error.message : 'Unknown error',
            );
          }
          return json(await this.ctx.storage.get('connection'));
        }
        if (url.pathname === '/models') {
          if (connection.status !== 'connected')
            return json({ error: '请先连接 ChatGPT 账号。' }, 409);
          const cached = await this.ctx.storage.get<{ at: number; data: unknown }>('models');
          if (cached && Date.now() - cached.at < 10 * 60 * 1000)
            return json(cached.data);
          try {
            await this.restoreCredentials();
            const models = await this.call('/models');
            await this.saveCredentials();
            await this.ctx.storage.put('models', { at: Date.now(), data: models });
            return json(models);
          } finally {
            await this.authBox().destroy();
          }
        }
        return json({ error: 'Not found' }, 404);
      } catch (error) {
        console.error(
          'Account route failed',
          url.pathname,
          error instanceof Error ? error.message.slice(0, 300) : 'Unknown error',
        );
        const githubError =
          url.pathname.startsWith('/github') && error instanceof Error
            ? error.message
            : null;
        return json(
          { error: githubError || '执行服务暂时不可用，请重试。' },
          503,
        );
      }
    });
  }
  async alarm(): Promise<void> {
    await this.exclusive(async () => {
      // Schedule before IO so eviction cannot strand a pending device login.
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      try {
        await this.tick();
        await this.ctx.storage.delete('failures');
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        console.error('Account login failed', message);
        const failures =
          ((await this.ctx.storage.get<number>('failures')) || 0) + 1;
        await this.ctx.storage.put('failures', failures);
        if (/OpenAI authentication failed \(403\)/.test(message) || failures >= 24) {
          await this.authBox().destroy().catch(() => {});
          await this.ctx.storage.put('connection', {
            status: 'error',
            error: /403/.test(message)
              ? 'OpenAI 拒绝了云端设备授权请求（HTTP 403）。'
              : '登录环境未能响应，请重新连接。',
          } satisfies Connection);
          await this.ctx.storage.deleteAlarm();
        } else {
          await this.ctx.storage.setAlarm(
            Date.now() + Math.min(60000, failures * 5000),
          );
        }
      }
    });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const owner = request.headers.get('x-owner');
    if (!owner || owner.length > 200)
      return json({ error: 'Missing identity' }, 401);
    const task = new URL(request.url).pathname.match(
      /^\/tasks\/([a-zA-Z0-9-]+)$/,
    );
    if (task)
      return env.SESSIONS.get(env.SESSIONS.idFromName(task[1])).fetch(request);
    return env.ACCOUNTS.get(env.ACCOUNTS.idFromName(owner)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
