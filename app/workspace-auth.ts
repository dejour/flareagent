import { headers } from 'next/headers';
import { env } from 'cloudflare:workers';
import { verifyAccessToken, type WorkspaceUser } from '@/lib/access';
export async function getWorkspaceUser(): Promise<WorkspaceUser | null> {
  const requestHeaders = await headers();
  // Vite substitutes DEV=false in production. Neither legacy Sites identity
  // headers nor this explicit local test identity grant production access.
  if (import.meta.env.DEV) {
    const host = requestHeaders.get('host')?.split(':')[0];
    if (host === 'localhost' || host === '127.0.0.1') {
      const testUser = requestHeaders.get('x-cloudagent-test-user');
      if (testUser && /^[a-zA-Z0-9-]{1,100}$/.test(testUser))
        return {
          userId: `local:${testUser}`,
          email: `${testUser}@localhost`,
          displayName: '本地测试账号',
        };
      if (
        requestHeaders
          .get('cookie')
          ?.split(';')
          .some((c) => c.trim() === 'cloudagent_local=1')
      )
        return {
          userId: 'local:developer',
          email: 'developer@localhost',
          displayName: '本地开发',
        };
    }
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = requestHeaders.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  return verifyAccessToken(token, {
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    audience: env.ACCESS_AUD,
  });
}
