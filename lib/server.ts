import { getWorkspaceUser } from '@/app/workspace-auth';
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function owner() {
  const user = await getWorkspaceUser();
  if (!user) throw new HttpError(401, '请先登录工作台。');
  return user.userId;
}
export function writeGuard(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    throw new HttpError(403, '不允许跨站修改数据。');
  if (request.headers.get('sec-fetch-site') === 'cross-site')
    throw new HttpError(403, '不允许跨站修改数据。');
  if (!request.headers.get('content-type')?.includes('application/json'))
    throw new HttpError(415, '请使用 JSON 请求。');
}
export async function readBody(request: Request) {
  if (Number(request.headers.get('content-length')) > 65536)
    throw new HttpError(413, '提交内容过大。');
  const text = await request.text();
  if (text.length > 65536) throw new HttpError(413, '提交内容过大。');
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, '请求格式不正确。');
  }
}
export function string(value: unknown, max: number, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new HttpError(400, `${label}不能为空，且不能超过 ${max} 字。`);
  return value.trim();
}
export function optionalString(value: unknown, max: number, label: string) {
  if (value === undefined || value === '') return '';
  return string(value, max, label);
}
export async function route(fn: () => Promise<unknown>, status = 200) {
  try {
    return Response.json(await fn(), {
      status,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    if (e instanceof HttpError)
      return Response.json({ error: e.message }, { status: e.status });
    console.error(
      'Request failed',
      e instanceof Error ? e.message : 'Unknown error',
    );
    return Response.json(
      { error: '服务暂时不可用，请稍后重试。' },
      { status: 503 },
    );
  }
}
