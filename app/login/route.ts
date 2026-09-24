import { env } from 'cloudflare:workers';
export async function GET(request: Request) {
  const url = new URL(request.url);
  if (
    import.meta.env.DEV &&
    ['localhost', '127.0.0.1'].includes(url.hostname)
  ) {
    if (
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      (request.headers.get('origin') &&
        request.headers.get('origin') !== url.origin)
    )
      return new Response('Forbidden', { status: 403 });
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': 'cloudagent_local=1; Path=/; HttpOnly; SameSite=Lax',
        'Cache-Control': 'no-store',
      },
    });
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD)
    return new Response(
      '工作台尚未配置 Cloudflare Access。请先在自己的 Cloudflare 账号中配置访问策略及应用 AUD。',
      {
        status: 503,
        headers: {
          'Content-Type': 'text/plain;charset=utf-8',
          'Cache-Control': 'no-store',
        },
      },
    );
  return Response.redirect(new URL('/', request.url), 302);
}
