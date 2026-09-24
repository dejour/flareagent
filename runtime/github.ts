import { seal, unseal } from './crypto';
export type GitHubEnv = {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_APP_SLUG?: string;
  PUBLIC_ORIGIN?: string;
  CREDENTIAL_KEY: string;
};
type Tokens = {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
};
export type Repo = {
  id: number;
  full_name: string;
  default_branch: string;
  installation_id: number;
  permissions?: { push?: boolean };
};
export class GitHubConnection {
  constructor(
    private env: GitHubEnv,
    private storage: DurableObjectStorage,
    private owner: string,
  ) {}
  private configured() {
    return !!(
      this.env.GITHUB_CLIENT_ID &&
      this.env.GITHUB_CLIENT_SECRET &&
      this.env.GITHUB_APP_SLUG &&
      this.env.PUBLIC_ORIGIN
    );
  }
  private callback() {
    return `${this.env.PUBLIC_ORIGIN}/api/connections/github/callback`;
  }
  async status() {
    return {
      configured: this.configured(),
      connected: !!(await this.storage.get('githubTokens')),
      login: await this.storage.get('githubLogin'),
      installUrl: this.env.GITHUB_APP_SLUG
        ? `https://github.com/apps/${this.env.GITHUB_APP_SLUG}/installations/new`
        : null,
    };
  }
  async begin() {
    if (!this.configured()) throw new Error('GitHub App 尚未配置。');
    const state = crypto.randomUUID();
    await this.storage.put('githubOAuth', {
      state,
      expires: Date.now() + 10 * 60 * 1000,
    });
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: this.env.GITHUB_CLIENT_ID!,
      redirect_uri: this.callback(),
      state,
    }).toString();
    return { url: url.toString() };
  }
  async complete(code: string, state: string) {
    const expected = await this.storage.get<{ state: string; expires: number }>(
      'githubOAuth',
    );
    if (!expected || expected.state !== state || expected.expires < Date.now())
      throw new Error('GitHub 授权已过期，请重新连接。');
    await this.storage.delete('githubOAuth');
    await this.exchange({ code, redirect_uri: this.callback() });
    const user = await this.api<{ login: string }>('/user');
    await this.storage.put('githubLogin', user.login);
    return { ok: true };
  }
  async disconnect() {
    await this.storage.delete(['githubTokens', 'githubLogin', 'githubOAuth']);
    return { ok: true };
  }
  private async exchange(params: Record<string, string>) {
    const response = await fetch(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          client_id: this.env.GITHUB_CLIENT_ID,
          client_secret: this.env.GITHUB_CLIENT_SECRET,
          ...params,
        }),
      },
    );
    const body = await response.json<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    }>();
    if (!response.ok || !body.access_token)
      throw new Error('GitHub 授权失败，请重新连接。');
    const tokens: Tokens = {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: Date.now() + (body.expires_in || 28800) * 1000,
    };
    await this.storage.put(
      'githubTokens',
      await seal(
        this.env.CREDENTIAL_KEY,
        `${this.owner}/github`,
        new TextEncoder().encode(JSON.stringify(tokens)).buffer,
      ),
    );
    return tokens;
  }
  private async token() {
    const bytes = await this.storage.get<Uint8Array>('githubTokens');
    if (!bytes) throw new Error('请先连接 GitHub。');
    let tokens: Tokens = JSON.parse(
      new TextDecoder().decode(
        await unseal(
          this.env.CREDENTIAL_KEY,
          `${this.owner}/github`,
          bytes.buffer as ArrayBuffer,
        ),
      ),
    );
    if (tokens.expires_at < Date.now() + 60000) {
      if (!tokens.refresh_token)
        throw new Error('GitHub 授权已过期，请重新连接。');
      tokens = await this.exchange({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
      });
    }
    return tokens.access_token;
  }
  private async api<T>(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${await this.token()}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'FlareAgent',
        'content-type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(`GitHub 请求失败 (${response.status})，请检查仓库授权。`);
    return response.json<T>();
  }
  async repositories() {
    const result: Repo[] = [];
    for (let page = 1; ; page++) {
      const { installations } = await this.api<{
        installations: { id: number }[];
      }>(`/user/installations?per_page=100&page=${page}`);
      for (const installation of installations) {
        for (let p = 1; ; p++) {
          const { repositories } = await this.api<{
            repositories: Omit<Repo, 'installation_id'>[];
          }>(
            `/user/installations/${installation.id}/repositories?per_page=100&page=${p}`,
          );
          result.push(
            ...repositories.map((r) => ({
              id: r.id,
              full_name: r.full_name,
              default_branch: r.default_branch,
              permissions: r.permissions,
              installation_id: installation.id,
            })),
          );
          if (repositories.length < 100) break;
        }
      }
      if (installations.length < 100) break;
    }
    return result;
  }
  async authorize(repoId: number, installationId: number) {
    const repo = (await this.repositories()).find(
      (r) => r.id === repoId && r.installation_id === installationId,
    );
    if (!repo) throw new Error('当前 GitHub 授权不包含此仓库。');
    return repo;
  }
  // This value is only passed between trusted DOs, never to the container or tool result.
  async gitCredential(repoId: number, installationId: number) {
    const repo = await this.authorize(repoId, installationId);
    return { repo, token: await this.token() };
  }
  async issues(repo: Repo) {
    return this.api(`/repos/${repo.full_name}/issues?state=open&per_page=30`);
  }
  async createPR(
    repo: Repo,
    input: { head: string; base: string; title: string; body: string },
  ) {
    if (!/^(?:flareagent|cloudagent)\/[a-zA-Z0-9_-]+$/.test(input.head))
      throw new Error('只能为 FlareAgent 分支创建 PR。');
    return this.api(`/repos/${repo.full_name}/pulls`, 'POST', {
      ...input,
      draft: true,
    });
  }
}
export const githubTools = [
  {
    type: 'function',
    name: 'github_issues',
    description: 'Read open issues in the current project repository.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'github_push',
    description:
      'Publish a committed flareagent/ task branch in the authorized project repository. GitHub credentials remain outside the sandbox.',
    inputSchema: {
      type: 'object',
      properties: { branch: { type: 'string' } },
      required: ['branch'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'github_create_pr',
    description:
      'Create a draft pull request for the authorized project repository.',
    inputSchema: {
      type: 'object',
      properties: {
        head: { type: 'string' },
        base: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['head', 'base', 'title', 'body'],
      additionalProperties: false,
    },
  },
];
