import { env } from 'cloudflare:workers';
import { HttpError } from './server';
export function hasRuntime() {
  return !!env.RUNTIME;
}
export async function runtime<T = Record<string, unknown>>(
  owner: string,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  if (!env.RUNTIME) throw new HttpError(503, '执行服务未启动。');
  const response = await env.RUNTIME.fetch(
    new Request('https://runtime' + path, {
      method,
      headers: { 'x-owner': owner, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const result = await response.json<Record<string, unknown>>();
  if (!response.ok)
    throw new HttpError(
      response.status,
      String(result.error || '执行服务暂时不可用。'),
    );
  return result as T;
}
