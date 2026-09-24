import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
export type AccessConfig = { teamDomain: string; audience: string };
export type WorkspaceUser = {
  userId: string;
  displayName: string;
  email: string;
};
export function accessIssuer(config: AccessConfig) {
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(
      config.teamDomain,
    ) ||
    !config.audience.trim()
  ) {
    throw new Error('Cloudflare Access is not configured');
  }
  return `https://${config.teamDomain}`;
}
const resolvers = new Map<string, JWTVerifyGetKey>();
// The optional key resolver is for offline cryptographic tests. Production only
// calls this with trusted deployment configuration, never caller-supplied keys.
export async function verifyAccessToken(
  token: string,
  config: AccessConfig,
  key?: JWTVerifyGetKey,
): Promise<WorkspaceUser | null> {
  const issuer = accessIssuer(config);
  let resolver = key ?? resolvers.get(issuer);
  if (!resolver) {
    resolver = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    resolvers.set(issuer, resolver);
  }
  try {
    const { payload } = await jwtVerify(token, resolver, {
      issuer,
      audience: config.audience,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'email', 'exp', 'iat'],
    });
    if (
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.email !== 'string' ||
      !payload.email
    )
      return null;
    return {
      userId: `${config.teamDomain}:${payload.sub}`,
      email: payload.email,
      displayName:
        typeof payload.name === 'string' ? payload.name : payload.email,
    };
  } catch {
    return null;
  }
}
