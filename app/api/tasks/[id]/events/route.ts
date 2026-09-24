import { getDb } from '@/db';
import { runtime, hasRuntime } from '@/lib/runtime';
import {
  owner,
  route,
  writeGuard,
  readBody,
  string,
  HttpError,
} from '@/lib/server';
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return route(async () => {
    writeGuard(request);
    const user = await owner(),
      { id } = await ctx.params,
      body = await readBody(request),
      content = string(body.content, 20000, '补充要求'),
      db = getDb();
    if (hasRuntime())
      return runtime(user, `/tasks/${id}`, 'POST', {
        action: 'message',
        content,
      });
    const task = await db
      .prepare('SELECT status FROM tasks WHERE id=? AND owner_id=?')
      .bind(id, user)
      .first();
    if (!task) throw new HttpError(404, '任务不存在。');
    if (task.status !== 'waiting_auth')
      throw new HttpError(409, '当前状态不能补充要求。');
    const eventId = crypto.randomUUID(),
      now = new Date().toISOString();
    const results = await db.batch([
      db
        .prepare(
          "INSERT INTO task_events(id,task_id,kind,content,created_at) SELECT ?,id,'user',?,? FROM tasks WHERE id=? AND owner_id=? AND status='waiting_auth'",
        )
        .bind(eventId, content, now, id, user),
      db
        .prepare(
          'UPDATE tasks SET updated_at=? WHERE id=? AND owner_id=? AND changes()=1',
        )
        .bind(now, id, user),
    ]);
    if (!results[0].meta.changes)
      throw new HttpError(409, '任务状态已改变，请重试。');
    return { id: eventId };
  }, 201);
}
