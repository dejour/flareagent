import { getDb } from '@/db';
import { runtime } from '@/lib/runtime';
import {
  owner,
  route,
  writeGuard,
  readBody,
  string,
  optionalString,
} from '@/lib/server';
export async function POST(request: Request) {
  return route(async () => {
    writeGuard(request);
    const user = await owner(),
      body = await readBody(request);
    const repo = body.repoId
      ? await runtime<{
          id: number;
          full_name: string;
          installation_id: number;
        }>(user, '/github/authorize', 'POST', {
          repoId: body.repoId,
          installationId: body.installationId,
        })
      : null;
    if (repo) {
      const existing = await getDb()
        .prepare(
          'SELECT id,name,description,created_at,github_repo FROM projects WHERE owner_id=? AND github_repo_id=?',
        )
        .bind(user, repo.id)
        .first();
      if (existing) return { project: existing };
    }
    const project = {
      id: crypto.randomUUID(),
      name: string(body.name, 80, '项目名称'),
      description: optionalString(body.description, 4000, '项目说明'),
      github_repo: repo?.full_name || null,
      created_at: new Date().toISOString(),
    };
    await getDb()
      .prepare(
        'INSERT OR IGNORE INTO projects(id,owner_id,name,description,created_at,github_repo,github_repo_id,github_installation_id) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        project.id,
        user,
        project.name,
        project.description,
        project.created_at,
        repo?.full_name || null,
        repo?.id || null,
        repo?.installation_id || null,
      )
      .run();
    if (repo)
      return {
        project: await getDb()
          .prepare(
            'SELECT id,name,description,created_at,github_repo FROM projects WHERE owner_id=? AND github_repo_id=?',
          )
          .bind(user, repo.id)
          .first(),
      };
    return { project };
  }, 201);
}
