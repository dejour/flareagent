import { env } from 'cloudflare:workers';
import { getDb } from '@/db';
import { owner, route, HttpError } from '@/lib/server';

const types: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
};
const MAX_SIZE = 8 * 1024 * 1024;

function validFile(name: string, bytes: Uint8Array, mime: string) {
  const prefix = (s: string) => s.split('').every((char, i) => bytes[i] === char.charCodeAt(0));
  if (mime === 'image/png') return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/webp') return prefix('RIFF') && bytes.slice(8, 12).every((v, i) => v === 'WEBP'.charCodeAt(i));
  if (mime === 'image/gif') return prefix('GIF87a') || prefix('GIF89a');
  if (mime === 'application/pdf') return prefix('%PDF-');
  return !bytes.includes(0) && !!name;
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return route(async () => {
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, '不允许跨站上传。');
    if (request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, '不允许跨站上传。');
    if (!request.headers.get('content-type')?.includes('multipart/form-data')) throw new HttpError(415, '请上传文件。');
    if (Number(request.headers.get('content-length')) > MAX_SIZE + 1024 * 1024) throw new HttpError(413, '文件不能超过 8 MB。');
    const user = await owner();
    const { id } = await ctx.params;
    const db = getDb();
    const task = await db.prepare('SELECT status,run_id FROM tasks WHERE id=? AND owner_id=?').bind(id, user).first<{status: string; run_id: string | null}>();
    if (!task) throw new HttpError(404, '任务不存在。');
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File) || !file.size || file.size > MAX_SIZE) throw new HttpError(413, '请选择不超过 8 MB 的文件。');
    const name = Array.from(file.name.split(/[\\/]/).at(-1) || 'attachment')
      .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
      .join('').slice(0, 120);
    const mime = types[name.split('.').at(-1)?.toLowerCase() || ''];
    if (!mime) throw new HttpError(415, '支持 PNG、JPEG、WebP、GIF、PDF、TXT 和 Markdown。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!validFile(name, bytes, mime)) throw new HttpError(415, '文件内容与格式不符。');
    let eventId: string | null = null;
    if (new URL(request.url).searchParams.get('initial') === '1') {
      if (task.status !== 'waiting_auth' || task.run_id) throw new HttpError(409, '任务已启动，不能修改初始消息。');
      const event = await db.prepare("SELECT id FROM task_events WHERE task_id=? AND kind='user' ORDER BY rowid LIMIT 1").bind(id).first<{id: string}>();
      eventId = event?.id || null;
      if (!eventId) throw new HttpError(409, '初始消息不存在。');
    }
    const count = await db.prepare('SELECT COUNT(*) AS count FROM task_attachments WHERE task_id=? AND event_id IS ?')
      .bind(id, eventId).first<{count: number}>();
    if ((count?.count || 0) >= (eventId ? 4 : 16)) throw new HttpError(413, '本任务待发送附件过多。');
    const attachmentId = crypto.randomUUID();
    const key = `${user}/tasks/${id}/attachments/${attachmentId}`;
    await env.STORAGE.put(key, bytes, { httpMetadata: { contentType: mime } });
    try {
      await db.prepare('INSERT INTO task_attachments(id,task_id,event_id,name,mime,size,created_at) VALUES(?,?,?,?,?,?,?)')
        .bind(attachmentId, id, eventId, name, mime, bytes.length, new Date().toISOString()).run();
    } catch (error) {
      await env.STORAGE.delete(key);
      throw error;
    }
    return { id: attachmentId, name, mime, size: bytes.length, event_id: eventId };
  }, 201);
}
