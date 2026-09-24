import { owner, route, HttpError } from '@/lib/server';
import { runtime } from '@/lib/runtime';
export async function GET(request: Request) {
  const result = await route(async () => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code'),
      state = url.searchParams.get('state');
    if (!code || !state || code.length > 1024 || state.length > 128)
      throw new HttpError(400, 'GitHub 授权未完成，请返回设置重新连接。');
    return runtime(await owner(), '/github/callback', 'POST', { code, state });
  });
  if (!result.ok) return result;
  return new Response(null, {
    status: 303,
    headers: {
      location: '/#settings',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}
