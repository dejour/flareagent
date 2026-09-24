import { getDb } from '@/db';
import { owner, route } from '@/lib/server';
export async function GET() {
  return route(async () => {
    const id = await owner(),
      db = getDb();
    const [tasks, projects] = await Promise.all([
      db
        .prepare(
          'SELECT id,title,prompt,model,project_id,status,created_at,updated_at FROM tasks WHERE owner_id=? ORDER BY updated_at DESC LIMIT 200',
        )
        .bind(id)
        .all(),
      db
        .prepare(
          'SELECT id,name,description,created_at,github_repo FROM projects WHERE owner_id=? ORDER BY created_at DESC LIMIT 200',
        )
        .bind(id)
        .all(),
    ]);
    return { tasks: tasks.results, projects: projects.results };
  });
}
