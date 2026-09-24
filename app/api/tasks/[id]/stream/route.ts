import { getDb } from '@/db';
import { owner, HttpError } from '@/lib/server';

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await owner();
  const { id } = await ctx.params;
  const db = getDb();
  const task = await db
    .prepare('SELECT id FROM tasks WHERE id=? AND owner_id=?')
    .bind(id, user)
    .first();
  if (!task) throw new HttpError(404, '任务不存在。');
  const lastId =
    request.headers.get('last-event-id') ||
    new URL(request.url).searchParams.get('after');
  let cursor = lastId
    ? Number(lastId)
    : (
        await db
          .prepare('SELECT MAX(rowid) AS last FROM task_events WHERE task_id=?')
          .bind(id)
          .first<{ last: number | null }>()
      )?.last || 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const started = Date.now();
      try {
        while (!request.signal.aborted && Date.now() - started < 25000) {
          const rows = await db
            .prepare(
              'SELECT rowid,id,kind,content,created_at FROM task_events WHERE task_id=? AND rowid>? ORDER BY rowid LIMIT 50',
            )
            .bind(id, cursor)
            .all<{
              rowid: number;
              id: string;
              kind: string;
              content: string;
              created_at: string;
            }>();
          for (const event of rows.results) {
            cursor = event.rowid;
            controller.enqueue(
              encoder.encode(
                `id: ${cursor}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            );
          }
          if (!rows.results.length)
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (error) {
        controller.error(error);
        return;
      }
      controller.close();
    },
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
