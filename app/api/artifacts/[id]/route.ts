import { env } from 'cloudflare:workers';
import { owner, HttpError } from '@/lib/server';
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await owner(),
      { id } = await ctx.params;
    const artifact = await env.DB.prepare(
      'SELECT a.name,a.size,a.object_key FROM artifacts a JOIN tasks t ON t.id=a.task_id WHERE a.id=? AND t.owner_id=?',
    )
      .bind(id, user)
      .first<{ name: string; size: number; object_key: string }>();
    if (!artifact) throw new HttpError(404, '成果不存在。');
    const object = await env.STORAGE.get(artifact.object_key);
    if (!object) throw new HttpError(404, '成果文件不存在。');
    return new Response(object.body, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
        'content-length': String(object.size),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof HttpError ? e.message : '下载失败，请重试。' },
      { status: e instanceof HttpError ? e.status : 503 },
    );
  }
}
