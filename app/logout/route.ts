export async function GET(request: Request) {
  const url = new URL(request.url);
  if (import.meta.env.DEV && ['localhost', '127.0.0.1'].includes(url.hostname))
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie':
          'cloudagent_local=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
        'Cache-Control': 'no-store',
      },
    });
  return Response.redirect(new URL('/cdn-cgi/access/logout', url), 302);
}
