import { DurableObject } from 'cloudflare:workers';
import { githubTools } from './github';
import type { AccountAgent } from './index';
import { CodexAdapter, type CodexSnapshot } from './codex-adapter';
import {
  SessionSandbox,
  type SandboxEnv,
  type WorkspaceBackup,
} from './sandbox-adapter';

type Env = SandboxEnv & {
  DB: D1Database;
  STORAGE: R2Bucket;
  ACCOUNTS: DurableObjectNamespace<AccountAgent>;
};
type Task = {
  id: string;
  owner_id: string;
  project_id: string | null;
  model: string | null;
  prompt: string;
  status: string;
};
type Project = {
  description: string;
  github_repo_id: number | null;
  github_installation_id: number | null;
};
type Run = {
  id: string;
  bootId?: string;
  ack: number;
  inputCount: number;
  startedAt: number;
  stoppingAt?: number;
  dispatched?: boolean;
  lastAuthSavedAt?: number;
};
type Session = {
  sessionId: string;
  userId: string;
  repo: string | null;
  sandboxId: string;
  codexThreadId: string | null;
  currentRun: Run | null;
  status: string;
  latestBackup: WorkspaceBackup | null;
  baseCommit: string | null;
  latestCheckpointKey: string | null;
  operationState: Record<string, 'started' | 'succeeded' | 'uncertain'>;
  consumedMessages: number;
  threadStarted?: boolean;
};
type Tool = { id: string; tool: string; arguments: Record<string, string> };
type Snapshot = CodexSnapshot;
const stamp = () => new Date().toISOString();
const EMPTY_BASE = '0000000000000000000000000000000000000000';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

// Session logical state lives here. A restarted Sandbox is never allowed to
// become the source of truth for a run or for a GitHub side effect.
export class SessionAgent extends DurableObject<Env> {
  private serial: Promise<unknown> = Promise.resolve();
  private exclusive<T>(f: () => Promise<T>): Promise<T> {
    const p = this.serial.then(f);
    this.serial = p.catch(() => {});
    return p;
  }
  private async task(owner: string, id: string): Promise<Task> {
    const task = await this.env.DB.prepare(
      'SELECT * FROM tasks WHERE id=? AND owner_id=?',
    )
      .bind(id, owner)
      .first<Task>();
    if (!task) throw new Error('任务不存在。');
    return task;
  }
  private async project(task: Task): Promise<Project | null> {
    return task.project_id
      ? this.env.DB.prepare(
          'SELECT description,github_repo_id,github_installation_id FROM projects WHERE id=? AND owner_id=?',
        )
          .bind(task.project_id, task.owner_id)
          .first<Project>()
      : null;
  }
  private account(userId: string) {
    return this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName(userId));
  }
  private box(s: Session) {
    return new SessionSandbox(this.env, s.sandboxId);
  }
  private codex(s: Session) {
    return new CodexAdapter(this.box(s));
  }
  private async state(task: Task): Promise<Session> {
    let s = await this.ctx.storage.get<Session>('session');
    if (s && (s.sessionId !== task.id || s.userId !== task.owner_id))
      throw new Error('Session ownership mismatch');
    if (!s) {
      s = {
        sessionId: task.id,
        userId: task.owner_id,
        repo: null,
        sandboxId: task.id,
        codexThreadId: null,
        currentRun: null,
        status: task.status,
        latestBackup: null,
        baseCommit: null,
        latestCheckpointKey: null,
        operationState: {},
        consumedMessages: 0,
      };
      await this.ctx.storage.put('session', s);
    }
    return s;
  }
  private async save(s: Session) {
    await this.ctx.storage.put('session', s);
  }
  private async transition(
    s: Session,
    status: string,
    message: string,
    eventId = crypto.randomUUID(),
  ) {
    s.status = status;
    await this.save(s);
    const time = stamp();
    await this.env.DB.batch([
      this.env.DB.prepare(
        'UPDATE tasks SET status=?,updated_at=? WHERE id=? AND owner_id=?',
      ).bind(status, time, s.sessionId, s.userId),
      this.env.DB.prepare(
        "INSERT OR IGNORE INTO task_events(id,task_id,kind,content,created_at) VALUES(?,?,'system',?,?)",
      ).bind(eventId, s.sessionId, message, time),
    ]);
  }
  async fetch(request: Request): Promise<Response> {
    return this.exclusive(async () => {
      try {
        const owner = request.headers.get('x-owner');
        const match = new URL(request.url).pathname.match(
          /^\/tasks\/([a-zA-Z0-9-]+)$/,
        );
        if (!owner || !match) return json({ error: 'Not found' }, 404);
        const task = await this.task(owner, match[1]);
        const s = await this.state(task);
        if (request.method === 'GET')
          return json({
            sessionId: s.sessionId,
            sandboxId: s.sandboxId,
            codexThreadId: s.codexThreadId,
            latestBackupId: s.latestCheckpointKey || s.latestBackup?.id || null,
            lastFailure: (await this.ctx.storage.get<string>('lastFailure')) || null,
          });
        const body = await request.json<Record<string, string>>();
        if (body.action === 'message') {
          if (!body.content?.trim() || body.content.length > 20000)
            return json({ error: '补充要求无效。' }, 400);
          if (s.currentRun && s.status !== 'needs_attention')
            return json({ error: '请先停止当前轮次，再补充要求。' }, 409);
          if (s.status === 'needs_attention') {
            // The interrupted instruction must not be replayed with the next message.
            const previous = await this.env.DB.prepare(
              "SELECT COUNT(*) AS count FROM task_events WHERE task_id=? AND kind='user'",
            )
              .bind(s.sessionId)
              .first<{ count: number }>();
            s.consumedMessages = previous?.count || 0;
            s.currentRun = null;
            if (s.threadStarted !== true) s.codexThreadId = null;
            await this.save(s);
          }
          await this.env.DB.batch([
            this.env.DB.prepare(
              "INSERT INTO task_events(id,task_id,kind,content,created_at) VALUES(?,?,'user',?,?)",
            ).bind(
              crypto.randomUUID(),
              s.sessionId,
              body.content.trim(),
              stamp(),
            ),
            this.env.DB.prepare(
              'UPDATE tasks SET updated_at=? WHERE id=? AND owner_id=?',
            ).bind(stamp(), s.sessionId, s.userId),
          ]);
          return json({ ok: true });
        }
        if (body.action === 'cancel') {
          if (s.currentRun) {
            s.currentRun.stoppingAt ||= Date.now();
            await this.transition(s, 'cancelling', '已请求停止当前轮次。');
            await this.wake();
          } else if (['queued', 'waiting_auth', 'draft'].includes(s.status))
            await this.transition(s, 'cancelled', '任务已停止，会话仍可继续。');
          return json({ ok: true });
        }
        if (body.action === 'start' || body.action === 'resume') {
          if (s.currentRun || s.status === 'queued')
            return json({ status: s.status });
          if (
            ![
              'waiting_auth',
              'draft',
              'cancelled',
              'failed',
              'completed',
              'needs_attention',
            ].includes(s.status)
          )
            return json({ error: '当前状态无法启动。' }, 409);
          try {
            await this.account(owner).sessionCredentials(owner);
          } catch {
            await this.transition(s, 'waiting_auth', '等待连接 ChatGPT 账号。');
            return json({ status: 'waiting_auth' });
          }
          if (s.status === 'needs_attention' && s.threadStarted !== true && s.consumedMessages === 0) {
            // Older first-turn attempts could persist a thread ID before
            // Codex wrote its first resumable rollout.
            s.codexThreadId = null;
            await this.save(s);
          }
          await this.transition(s, 'queued', '任务已进入执行队列。');
          await this.wake();
          return json({ status: 'queued' });
        }
        return json({ error: '操作无效。' }, 400);
      } catch (error) {
        console.error('Session request failed', error);
        return json(
          {
            error:
              error instanceof Error ? error.message : '执行服务暂时不可用。',
          },
          503,
        );
      }
    });
  }
  private async wake() {
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }
  async alarm() {
    await this.exclusive(async () => {
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      const s = await this.ctx.storage.get<Session>('session');
      if (!s) return this.ctx.storage.deleteAlarm();
      try {
        if (s.currentRun) await this.poll(s);
        else if (s.status === 'queued') await this.start(s);
        else await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.delete('recoverOnWake');
        await this.ctx.storage.delete('failures');
        await this.ctx.storage.delete('lastFailure');
      } catch (error) {
        console.error('Session alarm failed', error);
        await this.ctx.storage.put(
          'lastFailure',
          error instanceof Error ? error.message.slice(0, 500) : 'Unknown error',
        );
        // Startup may report "Container starting" before any Codex turn was
        // dispatched. Retrying that preparation cannot replay agent work.
        if (s.status === 'queued' || (s.currentRun && !s.currentRun.dispatched)) {
          const count =
            ((await this.ctx.storage.get<number>('failures')) || 0) + 1;
          if (count < 6) {
            await this.ctx.storage.put('failures', count);
            await this.ctx.storage.setAlarm(Date.now() + count * 5000);
            return;
          }
        }
        if (s.currentRun || s.status === 'queued') {
          s.currentRun = null;
          await this.transition(
            s,
            'needs_attention',
            '执行已中断，不会自动重试。发送新消息可从上次保存的状态继续。',
          );
        }
        await this.ctx.storage.delete(['approvals', 'recoverOnWake']);
        await this.ctx.storage.deleteAlarm();
      }
    });
  }
  private async ensure(s: Session) {
    const box = this.box(s);
    if (!(await box.alive())) {
      try {
        await box.prepare();
        if (s.latestCheckpointKey) {
          if (!s.baseCommit) throw new Error('Session base commit is missing');
          if (s.repo) {
            const task = await this.task(s.userId, s.sessionId);
            const p = await this.project(task);
            if (!p?.github_repo_id || !p.github_installation_id)
              throw new Error('Repository access is unavailable');
            const { token } = await this.account(s.userId).sessionRepository(
              s.userId,
              p.github_repo_id,
              p.github_installation_id,
            );
            await box.clone(s.repo, token, s.baseCommit);
          }
          await box.startBridge();
          const saved = await this.env.STORAGE.get(s.latestCheckpointKey);
          if (!saved) throw new Error('Session checkpoint is missing');
          await box.importChanges(s.baseCommit, await saved.arrayBuffer());
        } else if (s.latestBackup) {
          // Existing sessions keep their old full backup until a compact
          // checkpoint successfully replaces it.
          await box.restore(s.latestBackup);
          if (s.repo && !s.baseCommit) s.baseCommit = await box.baseCommit();
        } else {
          const task = await this.task(s.userId, s.sessionId);
          const p = await this.project(task);
          if (p?.github_repo_id && p.github_installation_id) {
            const { repo, token } = await this.account(
              s.userId,
            ).sessionRepository(
              s.userId,
              p.github_repo_id,
              p.github_installation_id,
            );
            s.baseCommit = await box.clone(repo.full_name, token);
            s.repo = repo.full_name;
          } else s.baseCommit = EMPTY_BASE;
        }
        await box.mark();
        await this.save(s);
      } catch (error) {
        // A failed restore must never leave a partial workspace marked ready.
        await box.destroy().catch(console.error);
        throw error;
      }
    }
    await box.startBridge();
    return box;
  }
  private async checkpoint(s: Session, box: SessionSandbox) {
    const base = s.baseCommit || (s.repo ? await box.baseCommit() : EMPTY_BASE);
    const archive = await box.exportChanges(base);
    const key = `${s.userId}/tasks/${s.sessionId}/checkpoints/${crypto.randomUUID()}.zip`;
    await this.env.STORAGE.put(key, archive);
    const previous = s.latestCheckpointKey;
    s.baseCommit = base;
    s.latestCheckpointKey = key;
    s.latestBackup = null;
    await this.save(s);
    if (previous) await this.env.STORAGE.delete(previous).catch(console.error);
    return key;
  }
  private async start(s: Session) {
    const run: Run = s.currentRun || {
      id: crypto.randomUUID(),
      ack: 0,
      inputCount: 0,
      startedAt: Date.now(),
    };
    if (!s.currentRun) {
      s.currentRun = run;
      await this.transition(s, 'running', '正在启动独立 Sandbox。');
    }
    await this.env.DB.prepare(
      'UPDATE tasks SET run_id=?,workspace_id=? WHERE id=? AND owner_id=?',
    )
      .bind(run.id, s.sandboxId, s.sessionId, s.userId)
      .run();
    if (run.dispatched) {
      const snapshot = await this.codex(s).state();
      if (snapshot.active?.runId !== run.id) {
        s.currentRun = null;
        await this.transition(
          s,
          'needs_attention',
          '执行已中断，不会自动重试。发送新消息可从上次保存的状态继续。',
        );
        return;
      }
      run.bootId = snapshot.bootId;
      s.codexThreadId = snapshot.active.threadId;
      await this.save(s);
      return;
    }
    await this.ensure(s);
    const auth = await this.account(s.userId).sessionCredentials(s.userId);
    await this.codex(s).credentials(auth);
    const task = await this.task(s.userId, s.sessionId);
    const p = await this.project(task);
    const messages = await this.env.DB.prepare(
      "SELECT content FROM task_events WHERE task_id=? AND kind='user' ORDER BY created_at,rowid",
    )
      .bind(s.sessionId)
      .all<{ content: string }>();
    run.inputCount = messages.results.length;
    const prompt =
      (p?.description ? `项目背景：\n${p.description}\n\n` : '') +
      (messages.results
        .slice(s.consumedMessages)
        .map((m) => m.content)
        .join('\n\n补充要求：\n') ||
        '继续当前会话。先检查已有修改与外部操作状态，再推进任务。');
    run.dispatched = true;
    await this.save(s);
    const result = await this.codex(s).startTurn({
      runId: run.id,
      threadId: s.codexThreadId,
      prompt: prompt.slice(-60000),
      model: task.model,
      hasRepo: !!s.repo,
      dynamicTools: s.repo ? githubTools : [],
    });
    s.codexThreadId = result.threadId;
    s.threadStarted = true;
    run.bootId = result.bootId;
    await this.save(s);
  }
  private async poll(s: Session) {
    const run = s.currentRun!;
    if (!run.bootId) return this.start(s);
    const snapshot = await this.codex(s).state(run.ack);
    if (snapshot.bootId !== run.bootId || snapshot.active?.runId !== run.id) {
      s.currentRun = null;
      await this.transition(
        s,
        'needs_attention',
        '执行已中断，不会自动重试。发送新消息可从上次保存的状态继续。',
      );
      return;
    }
    if (snapshot.events?.length) {
      await this.env.DB.batch(
        snapshot.events.map((e) =>
          this.env.DB.prepare(
            'INSERT OR IGNORE INTO task_events(id,task_id,kind,content,created_at) VALUES(?,?,?,?,?)',
          ).bind(
            `${run.id}:${e.seq}`,
            s.sessionId,
            e.kind,
            e.content,
            e.createdAt,
          ),
        ),
      );
      run.ack = snapshot.events.at(-1)!.seq;
      await this.save(s);
    }
    for (const approval of snapshot.approvals || [])
      await this.codex(s).approve(approval.id, 'accept', run.id);
    for (const tool of snapshot.tools || [])
      await this.resolveTool(s, tool);
    await this.ctx.storage.delete('approvals');
    if (snapshot.active.status === 'needs_attention') {
      s.currentRun = null;
      await this.transition(
        s,
        'needs_attention',
        'Codex 执行已中断。发送新消息可从上次保存的状态继续。',
      );
      return;
    }
    if (['completed', 'cancelled', 'failed'].includes(snapshot.active.status)) {
      if (snapshot.events.length === 50) return;
      await this.finish(s, snapshot.active);
      return;
    }
    if (run.stoppingAt || Date.now() - run.startedAt > 20 * 60 * 1000) {
      run.stoppingAt ||= Date.now();
      await this.save(s);
      if (Date.now() - run.stoppingAt > 30000) {
        s.currentRun = null;
        await this.transition(
          s,
          'needs_attention',
          '执行已中断，停止请求未获确认。发送新消息可从上次保存的状态继续。',
        );
      } else await this.codex(s).cancel(run.id);
      return;
    }
    if (Date.now() - (run.lastAuthSavedAt || 0) > 60000) {
      const { credentials } = await this.codex(s).credentials();
      if (credentials)
        await this.account(s.userId).sessionSaveCredentials(
          s.userId,
          credentials,
        );
      run.lastAuthSavedAt = Date.now();
      await this.save(s);
    }
    const status = snapshot.active.status === 'waiting_approval'
      ? 'running'
      : snapshot.active.status;
    if (s.status !== status)
      await this.transition(
        s,
        status,
        '继续执行。',
      );
  }
  private async resolveTool(s: Session, tool: Tool) {
    const run = s.currentRun!;
    const key = `op:${run.id}:${tool.id}`;
    const stored = await this.ctx.storage.get<{
      status: string;
      text?: string;
      success?: boolean;
    }>(key);
    let result: { text: string; success: boolean };
    if (stored?.status === 'succeeded')
      result = { text: stored.text!, success: stored.success! };
    else if (stored)
      result = {
        text: '该操作的结果不确定，请先检查 GitHub；不会自动重放。',
        success: false,
      };
    else {
      await this.ctx.storage.put(key, { status: 'started' });
      s.operationState[key] = 'started';
      await this.save(s);
      try {
        const task = await this.task(s.userId, s.sessionId);
        const p = await this.project(task);
        if (!p?.github_repo_id || !p.github_installation_id)
          throw new Error('仓库尚未连接。');
        let output: unknown;
        if (tool.tool === 'github_push') {
          const { repo, token } = await this.account(
            s.userId,
          ).sessionRepository(
            s.userId,
            p.github_repo_id,
            p.github_installation_id,
          );
          output = await this.box(s).push(
            repo.full_name,
            token,
            tool.arguments.branch,
          );
        } else {
          output = await Promise.resolve(
            this.account(s.userId).sessionGitHubTool(
              s.userId,
              p.github_repo_id,
              p.github_installation_id,
              tool.tool,
              tool.arguments,
            ),
          );
        }
        result = {
          text: JSON.stringify(output).slice(0, 20000),
          success: true,
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : '';
        const safeReason = /^(GitHub push failed:|GitHub 请求失败 \(|GitHub 授权已过期|当前 GitHub 授权不包含此仓库|请先连接 GitHub)/.test(reason)
          ? reason.slice(0, 500)
          : '执行服务错误，请查看服务端日志。';
        result = {
          text: `GitHub 操作失败：${safeReason}`,
          success: false,
        };
      }
      await this.ctx.storage.put(key, { status: 'succeeded', ...result });
      s.operationState[key] = 'succeeded';
      await this.save(s);
    }
    await this.codex(s).toolResult(tool.id, run.id, result);
  }
  private async finish(s: Session, result: NonNullable<Snapshot['active']>) {
    const run = s.currentRun!;
    const box = this.box(s);
    await this.codex(s).finish(run.id);
    const { credentials } = await this.codex(s).credentials();
    if (credentials)
      await this.account(s.userId).sessionSaveCredentials(
        s.userId,
        credentials,
      );
    await this.codex(s).checkpoint();
    // Only a completed compact archive replaces the last known-good pointer.
    const checkpointKey = await this.checkpoint(s, box);
    s.codexThreadId = result.threadId;
    s.consumedMessages = run.inputCount;
    s.currentRun = null;
    await this.env.DB.prepare(
      'UPDATE tasks SET thread_id=?,checkpoint_key=?,checkpoint_message_count=? WHERE id=? AND owner_id=?',
    )
      .bind(
        result.threadId,
        checkpointKey,
        s.consumedMessages,
        s.sessionId,
        s.userId,
      )
      .run();
    await this.transition(
      s,
      result.status,
      result.status === 'completed'
        ? '轮次完成，代码改动与 Codex 会话已保存。'
        : result.status === 'cancelled'
          ? '轮次已停止，代码改动与 Codex 会话已保存。'
          : `轮次失败，代码改动已保存：${result.error || '请查看任务记录。'}`,
    );
    await this.ctx.storage.delete('approvals');
    await this.ctx.storage.deleteAlarm();
  }
}
