import { getDb } from '@/db';
import { owner, route, writeGuard, readBody, HttpError } from '@/lib/server';
import type { Task } from '@/lib/types';
import { runtime, hasRuntime } from '@/lib/runtime';
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, ctx: Context) {
  return route(async () => {
    const user = await owner(),
      { id } = await ctx.params,
      db = getDb();
    const task = await db
      .prepare(
        'SELECT id,title,prompt,model,project_id,status,created_at,updated_at FROM tasks WHERE id=? AND owner_id=?',
      )
      .bind(id, user)
      .first();
    if (!task) throw new HttpError(404, '任务不存在。');
    const events = await db
      .prepare(
        'SELECT id,task_id,kind,content,created_at FROM task_events WHERE task_id=? ORDER BY created_at,rowid LIMIT 1000',
      )
      .bind(id)
      .all();
    return {
      task,
      events: events.results,
    };
  });
}
export async function PATCH(request: Request, ctx: Context) {
  return route(async () => {
    writeGuard(request);
    const user = await owner(),
      { id } = await ctx.params,
      body = await readBody(request),
      db = getDb();
    if (hasRuntime()) return runtime(user, `/tasks/${id}`, 'POST', body);
    const task = await db
      .prepare('SELECT status FROM tasks WHERE id=? AND owner_id=?')
      .bind(id, user)
      .first<Task>();
    if (!task) throw new HttpError(404, '任务不存在。');
    if (body.action !== 'cancel' && body.action !== 'resume')
      throw new HttpError(400, '不支持的任务操作。');
    const next = body.action === 'cancel' ? 'cancelled' : 'waiting_auth';
    if (task.status === next) return { status: next };
    if (
      (body.action === 'cancel' &&
        !['waiting_auth', 'draft'].includes(task.status)) ||
      (body.action === 'resume' && task.status !== 'cancelled')
    )
      throw new HttpError(409, '当前状态不支持此操作。');
    const now = new Date().toISOString();
    const results = await db.batch([
      db
        .prepare(
          'UPDATE tasks SET status=?,updated_at=? WHERE id=? AND owner_id=? AND status=?',
        )
        .bind(next, now, id, user, task.status),
      db
        .prepare(
          "INSERT INTO task_events(id,task_id,kind,content,created_at) SELECT ?,?,'system',?,? WHERE changes()=1",
        )
        .bind(
          crypto.randomUUID(),
          id,
          body.action === 'cancel'
            ? '任务已停止。'
            : '任务已恢复为等待连接状态。',
          now,
        ),
    ]);
    if (!results[0].meta.changes)
      throw new HttpError(409, '任务状态已改变，请刷新后重试。');
    return { status: next };
  });
}
