import { env } from 'cloudflare:workers';
import { getDb } from '@/db';
import { owner, HttpError } from '@/lib/server';

export async function GET(_request: Request, ctx: { params: Promise<{ id: string; attachmentId: string }> }) {
  try {
    const user = await owner();
    const { id, attachmentId } = await ctx.params;
    const attachment = await getDb().prepare(
      'SELECT a.name,a.mime FROM task_attachments a JOIN tasks t ON t.id=a.task_id WHERE a.id=? AND a.task_id=? AND t.owner_id=?',
    ).bind(attachmentId, id, user).first<{name: string; mime: string}>();
    if (!attachment) throw new HttpError(404, '附件不存在。');
    const object = await env.STORAGE.get(`${user}/tasks/${id}/attachments/${attachmentId}`);
    if (!object) throw new HttpError(404, '附件不存在。');
    return new Response(object.body, {
      headers: {
        'content-type': attachment.mime,
        'content-disposition': `${attachment.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      },
    });
  } catch (error) {
    if (error instanceof HttpError)
      return Response.json({ error: error.message }, { status: error.status });
    console.error('Attachment read failed', error);
    return Response.json({ error: '附件暂时不可用。' }, { status: 503 });
  }
}
