import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

const bootId = randomUUID();
const secret = process.env.BRIDGE_SECRET;
if (!secret) throw new Error('BRIDGE_SECRET required');
const codexHome = process.env.CODEX_HOME || '/data/codex';
const authBase = 'https://auth.openai.com';
const codexClientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
const authUserAgent = 'Codex Desktop/26.707.31428 (linux; x64)';
const childEnv = {
  PATH: process.env.PATH,
  HOME: '/home/node',
  CODEX_HOME: codexHome,
  LANG: 'C.UTF-8',
};
process.on('uncaughtException', (error) => {
  void fs
    .writeFile(
      '/workspace/.cloudagent-bridge-error',
      String(error?.stack || error),
    )
    .finally(() => process.exit(1));
});
let engine,
  ready,
  nextId = 0,
  seq = 0,
  events = [],
  active = null,
  login = null;
const pending = new Map(),
  approvals = new Map(),
  tools = new Map();
function emit(kind, content) {
  if (!active) return;
  events.push({
    seq: ++seq,
    kind,
    content: String(content).slice(0, 20000),
    createdAt: new Date().toISOString(),
  });
  if (events.length > 2000) {
    engine?.kill('SIGTERM');
    active.status = 'failed';
    active.error = '输出超过单次任务上限。';
  }
}
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex ${method} timed out`));
    }, 45000);
    pending.set(id, { resolve, reject, timer });
    engine.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
async function startEngine() {
  if (ready) return ready;
  ready = (async () => {
    engine = spawn(
      'codex',
      ['app-server', '-c', 'cli_auth_credentials_store="file"'],
      {
        env: childEnv,
        cwd: '/workspace',
        uid: 1000,
        gid: 1000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    // Raw engine logs can contain account data; never relay them into task events.
    engine.stderr.on('data', () => {});
    engine.on('error', () => {});
    engine.on('exit', () => {
      ready = null;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Codex process exited'));
      }
      pending.clear();
      if (
        active &&
        ['running', 'waiting_approval', 'cancelling'].includes(active.status)
      ) {
        active.status = 'needs_attention';
        active.error = '执行进程退出，请检查外部操作后重试。';
      }
    });
    createInterface({ input: engine.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== undefined && !message.method) {
        const entry = pending.get(message.id);
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(message.id);
          message.error
            ? entry.reject(new Error(message.error.message))
            : entry.resolve(message.result);
        }
        return;
      }
      const p = message.params || {};
      if (message.id !== undefined && message.method) {
        if (active && message.method === 'item/tool/call') {
          tools.set(String(message.id), {
            id: String(message.id),
            rpcId: message.id,
            tool: p.tool,
            arguments: p.arguments,
          });
          // Host tools are resolved by SessionDO without interrupting the turn.
        } else if (
          active &&
          [
            'item/commandExecution/requestApproval',
            'item/fileChange/requestApproval',
          ].includes(message.method)
        ) {
          engine.stdin.write(
            JSON.stringify({ id: message.id, result: { decision: 'accept' } }) +
              '\n',
          );
        } else {
          engine.stdin.write(
            JSON.stringify({
              id: message.id,
              error: {
                code: -32601,
                message:
                  'This interactive request is not supported by FlareAgent',
              },
            }) + '\n',
          );
          emit('system', '执行引擎请求了暂不支持的交互操作。');
        }
      }
      if (
        message.method === 'account/login/completed' &&
        login?.loginId === p.loginId
      ) {
        login = {
          ...login,
          status: p.success ? 'connected' : 'error',
          error: p.error || null,
        };
      }
      if (!active || (p.threadId && p.threadId !== active.threadId)) return;
      if (message.method === 'turn/started') active.turnId = p.turn.id;
      if (message.method === 'item/completed') {
        const item = p.item || {};
        if (item.type === 'agentMessage') {
          emit('assistant', item.text || '');
          active.answer = item.text || active.answer;
        }
        if (item.type === 'commandExecution')
          emit(
            'tool',
            `${item.command || ''}\n${item.aggregatedOutput || ''}\nexit: ${item.exitCode ?? 'unknown'}`,
          );
        if (item.type === 'fileChange')
          emit(
            'tool',
            `文件更改：${(item.changes || []).map((c) => c.path).join(', ')}`,
          );
      }
      if (message.method === 'turn/completed') {
        const status = p.turn.status;
        active.status =
          status === 'completed'
            ? 'completed'
            : status === 'interrupted'
              ? 'cancelled'
              : 'failed';
        active.error = p.turn.error?.message || null;
        approvals.clear();
      }
    });
    await rpc('initialize', {
      clientInfo: { name: 'flareagent', title: 'FlareAgent', version: '0.3.0' },
      capabilities: { experimentalApi: true },
    });
    engine.stdin.write(
      JSON.stringify({ method: 'initialized', params: {} }) + '\n',
    );
  })();
  return ready;
}
async function stopEngine() {
  if (!engine || engine.exitCode !== null) {
    ready = null;
    return;
  }
  const child = engine;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    timer.unref();
  });
  ready = null;
}
async function command(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['/opt/cloudagent/session_archive.py', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      uid: 1000,
      gid: 1000,
      env: childEnv,
    });
    const out = [];
    let bytes = 0;
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 80 * 1024 * 1024) child.kill();
      else out.push(chunk);
    });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error('检查点归档失败或超过 80 MiB 限制。')),
    );
    child.stdin.end(input);
  });
}
async function reset() {
  await stopEngine();
  for (const dir of [codexHome]) {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    await fs.chown(dir, 1000, 1000);
  }
  active = null;
  events = [];
  seq = 0;
  approvals.clear();
  tools.clear();
}
async function credentials(value) {
  if (value !== undefined && value !== null) {
    if (typeof value !== 'string' || value.length > 65536)
      throw new Error('Invalid credential cache');
    JSON.parse(value);
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(path.join(codexHome, 'auth.json'), value, {
      mode: 0o600,
    });
    await fs.chown(path.join(codexHome, 'auth.json'), 1000, 1000);
  }
  return fs
    .readFile(path.join(codexHome, 'auth.json'), 'utf8')
    .catch(() => null);
}
async function authRequest(pathname, body, form = false) {
  const response = await fetch(authBase + pathname, {
    method: 'POST',
    headers: {
      'content-type': form
        ? 'application/x-www-form-urlencoded'
        : 'application/json',
      'user-agent': authUserAgent,
    },
    body: form ? new URLSearchParams(body) : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = new Error(
      `OpenAI authentication failed (${response.status})`,
    );
    error.status = response.status;
    throw error;
  }
  return response.json();
}
function jwtPayload(token) {
  const part = String(token).split('.')[1];
  if (!part) throw new Error('OpenAI returned an invalid token');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}
async function completeDeviceLogin(current) {
  try {
    const deadline = Date.now() + 15 * 60 * 1000;
    let code;
    while (Date.now() < deadline) {
      try {
        code = await authRequest('/api/accounts/deviceauth/token', {
          device_auth_id: current.deviceAuthId,
          user_code: current.userCode,
        });
        break;
      } catch (error) {
        if (![403, 404].includes(error.status)) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1000, current.interval * 1000)),
        );
      }
    }
    if (!code) throw new Error('设备授权已过期，请重试。');
    const tokens = await authRequest(
      '/oauth/token',
      {
        grant_type: 'authorization_code',
        client_id: codexClientId,
        redirect_uri: `${authBase}/deviceauth/callback`,
        code: code.authorization_code,
        code_verifier: code.code_verifier,
      },
      true,
    );
    const claims = jwtPayload(tokens.access_token);
    const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    if (!accountId) throw new Error('OpenAI 账号信息不完整');
    await stopEngine();
    await credentials(
      JSON.stringify({
        OPENAI_API_KEY: null,
        auth_mode: 'chatgpt',
        tokens: {
          id_token: tokens.id_token,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          account_id: accountId,
        },
        last_refresh: new Date().toISOString(),
      }),
    );
    if (login?.loginId === current.loginId)
      login = { ...login, status: 'connected' };
  } catch (error) {
    if (login?.loginId === current.loginId)
      login = { ...login, status: 'error', error: error.message };
  }
}
async function handle(url, body) {
  if (url.pathname === '/health') return { bootId, version: '0.154.0' };
  if (url.pathname === '/credentials' && body.clear) {
    await fs.rm(path.join(codexHome, 'auth.json'), { force: true });
    return { ok: true };
  }
  if (url.pathname === '/credentials')
    return { credentials: await credentials(body.credentials) };
  if (url.pathname === '/login') {
    if (
      login?.status === 'pending' &&
      Date.now() - login.startedAt < 10 * 60 * 1000
    )
      return login;
    // Codex's raw device-auth client omits its normal User-Agent and can be
    // challenged by the auth edge. Run the documented flow with that header.
    const result = await authRequest('/api/accounts/deviceauth/usercode', {
      client_id: codexClientId,
    });
    login = {
      verificationUrl: `${authBase}/codex/device`,
      userCode: result.user_code || result.usercode,
      loginId: randomUUID(),
      status: 'pending',
      startedAt: Date.now(),
      deviceAuthId: result.device_auth_id,
      interval: Number(result.interval) || 5,
    };
    void completeDeviceLogin(login);
    return login;
  }
  if (url.pathname === '/account') {
    if (login?.status !== 'connected') return { account: null, login, bootId };
    await startEngine();
    const result = await rpc('account/read', { refreshToken: false });
    return { account: result.account, login, bootId };
  }
  if (url.pathname === '/models') {
    await startEngine();
    const result = await rpc('model/list', {
      limit: 50,
      includeHidden: false,
    });
    return {
      models: (result.data || []).map(
        ({ model, displayName, isDefault, defaultReasoningEffort }) => ({
          model,
          displayName,
          isDefault,
          defaultReasoningEffort,
        }),
      ),
    };
  }
  if (url.pathname === '/prepare') {
    if (
      active &&
      ['running', 'waiting_approval', 'cancelling'].includes(active.status)
    )
      throw new Error('已有任务运行');
    await reset();
    return { bootId };
  }
  if (url.pathname === '/thread') {
    if (
      active &&
      ['running', 'waiting_approval', 'cancelling'].includes(active.status)
    )
      throw new Error('Another turn is active');
    await startEngine();
    const params = {
      cwd: body.hasRepo ? '/workspace/repo' : '/workspace',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      dynamicTools: body.threadId ? undefined : body.dynamicTools || [],
      model: body.model || undefined,
    };
    const result = body.threadId
      ? await rpc('thread/resume', { ...params, threadId: body.threadId })
      : await rpc('thread/start', params);
    return { threadId: result.thread.id, bootId };
  }
  if (url.pathname === '/run') {
    if (active?.runId === body.runId) return { ...active, bootId };
    if (active && ['completed', 'cancelled', 'failed'].includes(active.status)) {
      active = null;
      events = [];
      seq = 0;
      approvals.clear();
      tools.clear();
    }
    if (active) throw new Error('工作空间尚未重置');
    await startEngine();
    const params = {
      cwd: body.hasRepo ? '/workspace/repo' : '/workspace',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      developerInstructions: 'You are FlareAgent in an isolated Cloudflare sandbox. Complete the user task in /workspace/repo. Report the result directly in the conversation. GitHub credentials are held by the host; use github_push and github_create_pr tools for external writes. Create branches named flareagent/<task-name>. This workspace belongs only to this session. Preserve existing changes and continue the same thread. The turn has a 20 minute execution limit.',
    };
    if (!body.threadId) params.dynamicTools = body.dynamicTools || [];
    if (body.model) params.model = body.model;
    const result = body.threadId
      ? await rpc('thread/resume', { ...params, threadId: body.threadId })
      : await rpc('thread/start', params);
    active = {
      runId: body.runId,
      threadId: result.thread.id,
      status: 'running',
      answer: '',
      startedAt: Date.now(),
    };
    try {
      const turn = await rpc('turn/start', {
        threadId: active.threadId,
        input: [{ type: 'text', text: body.prompt }],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      });
      active.turnId = turn.turn.id;
    } catch (error) {
      active.status = 'failed';
      active.error = error.message;
    }
    return { ...active, bootId };
  }
  if (url.pathname === '/state') {
    if (body.ack) events = events.filter((e) => e.seq > body.ack);
    return {
      bootId,
      active,
      tools: [...tools.values()].map(({ rpcId, ...t }) => t),
      events: events.slice(0, 50),
      approvals: [...approvals.values()].map(({ rpcId, ...a }) => a),
    };
  }
  if (url.pathname === '/tool-result') {
    if (active?.runId !== body.runId) throw new Error('Execution changed');
    const tool = tools.get(body.id);
    if (tool) {
      engine.stdin.write(
        JSON.stringify({
          id: tool.rpcId,
          result: {
            contentItems: [{ type: 'inputText', text: body.text }],
            success: body.success,
          },
        }) + '\n',
      );
      tools.delete(body.id);
      active.status = approvals.size ? 'waiting_approval' : 'running';
      emit('tool', `${tool.tool}: ${body.text}`);
    }
    return { ok: true };
  }
  if (url.pathname === '/cancel') {
    if (!active || active.runId !== body.runId)
      throw new Error('Execution changed');
    if (['running', 'waiting_approval'].includes(active.status)) {
      active.status = 'cancelling';
      try {
        await rpc('turn/interrupt', {
          threadId: active.threadId,
          turnId: active.turnId,
        });
      } catch {
        if (active.status === 'cancelling') {
          active.status = 'needs_attention';
          active.error = '停止未获引擎确认，请检查后恢复。';
        }
      }
    }
    return { ok: true };
  }
  if (url.pathname === '/approve') {
    if (active?.runId !== body.runId) throw new Error('Execution changed');
    const a = approvals.get(body.id);
    if (!a) throw new Error('审批已失效');
    if (!['accept', 'decline'].includes(body.decision))
      throw new Error('Invalid decision');
    engine.stdin.write(
      JSON.stringify({ id: a.rpcId, result: { decision: body.decision } }) +
        '\n',
    );
    approvals.delete(body.id);
    active.status = approvals.size ? 'waiting_approval' : 'running';
    emit(
      'system',
      body.decision === 'accept' ? '用户允许本次操作。' : '用户拒绝本次操作。',
    );
    return { ok: true };
  }
  if (url.pathname === '/finish') {
    if (
      !active ||
      active.runId !== body.runId ||
      !['completed', 'cancelled', 'failed'].includes(active.status)
    )
      throw new Error('任务尚未终止');
    await stopEngine();
    // Stop orphaned task processes before collecting a stable checkpoint.
    await new Promise((resolve) => {
      const p = spawn('pkill', ['-KILL', '-u', '1000']);
      p.on('exit', resolve);
    });
    return { active };
  }
  if (url.pathname === '/checkpoint') {
    if (
      active &&
      ['running', 'waiting_approval', 'cancelling'].includes(active.status)
    )
      throw new Error('Cannot checkpoint an active turn');
    await stopEngine();
    await fs.rm(path.join(codexHome, 'auth.json'), { force: true });
    // The Sandbox backup process must be able to read Codex rollout files.
    const readable = spawn('chmod', ['-R', 'a+rX', codexHome]);
    await new Promise((resolve, reject) => {
      readable.on('error', reject);
      readable.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('chmod failed')),
      );
    });
    return { active, bootId };
  }
  throw new Error('Unknown bridge operation');
}
let serial = Promise.resolve();
http
  .createServer(async (request, response) => {
    const token = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${secret}`);
    if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
      response.writeHead(401);
      response.end();
      return;
    }
    const execute = async () => {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 80 * 1024 * 1024) throw new Error('Payload too large');
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks),
          url = new URL(request.url, 'http://localhost');
        if (url.pathname === '/session-snapshot') {
          if (active && ['running', 'waiting_approval', 'cancelling'].includes(active.status))
            throw new Error('Cannot checkpoint an active turn');
          if (await credentials())
            throw new Error('Remove model credentials before checkpoint');
          response.setHeader('content-type', 'application/zip');
          response.end(await command(['pack', url.searchParams.get('base') || '']));
          return;
        }
        if (url.pathname === '/session-restore') {
          await command(['restore', url.searchParams.get('base') || ''], bytes);
          response.end('{}');
          return;
        }
        const body = bytes.length ? JSON.parse(bytes.toString()) : {};
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(await handle(url, body)));
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error.message }));
      }
    };
    const operation = serial.then(execute);
    serial = operation.catch(() => {});
    await operation;
  })
  .listen(Number(process.env.BRIDGE_PORT || 8080), '0.0.0.0');
