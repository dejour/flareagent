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
    const attachments = body.attachments === undefined ? [] : body.attachments;
    if (!Array.isArray(attachments) || attachments.length > 4 ||
        attachments.some((value) => typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) ||
        new Set(attachments).size !== attachments.length)
      throw new HttpError(400, '附件无效。');
    if (hasRuntime())
      return runtime(user, `/tasks/${id}`, 'POST', {
        action: 'message',
        content,
        attachments,
      });
    const task = await db
      .prepare('SELECT status FROM tasks WHERE id=? AND owner_id=?')
      .bind(id, user)
      .first();
    if (!task) throw new HttpError(404, '任务不存在。');
    if (task.status !== 'waiting_auth')
      throw new HttpError(409, '当前状态不能补充要求。');
    if (attachments.length) {
      const placeholders = attachments.map(() => '?').join(',');
      const owned = await db.prepare(`SELECT id FROM task_attachments WHERE task_id=? AND event_id IS NULL AND id IN (${placeholders})`)
        .bind(id, ...attachments).all();
      if (owned.results.length !== attachments.length) throw new HttpError(400, '附件无效或已发送。');
    }
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
      ...attachments.map((attachmentId) => db.prepare('UPDATE task_attachments SET event_id=? WHERE id=? AND task_id=? AND event_id IS NULL')
        .bind(eventId, attachmentId, id)),
    ]);
    if (!results[0].meta.changes)
      throw new HttpError(409, '任务状态已改变，请重试。');
    return { id: eventId };
  }, 201);
}
