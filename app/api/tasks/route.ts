import { getDb } from '@/db';
import { runtime, hasRuntime } from '@/lib/runtime';
import {
  owner,
  route,
  writeGuard,
  readBody,
  string,
  HttpError,
} from '@/lib/server';
export async function POST(request: Request) {
  return route(async () => {
    writeGuard(request);
    const user = await owner(),
      body = await readBody(request),
      db = getDb();
    const prompt = string(body.prompt, 20000, '任务要求'),
      requestId = string(body.requestId, 100, '请求标识'),
      model = body.model ? string(body.model, 100, '模型') : null;
    if (model && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model))
      throw new HttpError(400, '模型标识无效。');
    let projectId: null | string = null;
    if (body.projectId !== null && body.projectId !== undefined) {
      projectId = string(body.projectId, 100, '项目标识');
      const project = await db
        .prepare('SELECT id FROM projects WHERE id=? AND owner_id=?')
        .bind(projectId, user)
        .first();
      if (!project) throw new HttpError(404, '项目不存在。');
    }
    const existing = await db
      .prepare(
        'SELECT id,title,prompt,model,project_id,status,created_at,updated_at FROM tasks WHERE owner_id=? AND request_id=?',
      )
      .bind(user, requestId)
      .first();
    if (existing) {
      if (
        existing.prompt !== prompt ||
        existing.project_id !== projectId ||
        existing.model !== model
      )
        throw new HttpError(409, '请求标识已用于另一项任务。');
      return { task: existing };
    }
    const id = crypto.randomUUID(),
      now = new Date().toISOString(),
      title = prompt.split('\n')[0].slice(0, 80);
    await db.batch([
      db
        .prepare(
          'INSERT INTO tasks(id,owner_id,request_id,title,prompt,model,project_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,request_id) DO NOTHING',
        )
        .bind(
          id,
          user,
          requestId,
          title,
          prompt,
          model,
          projectId,
          'waiting_auth',
          now,
          now,
        ),
      db
        .prepare(
          "INSERT INTO task_events(id,task_id,kind,content,created_at) SELECT ?,id,'user',?,? FROM tasks WHERE id=? AND owner_id=?",
        )
        .bind(crypto.randomUUID(), prompt, now, id, user),
      db
        .prepare(
          "INSERT INTO task_events(id,task_id,kind,content,created_at) SELECT ?,id,'system',?,? FROM tasks WHERE id=? AND owner_id=?",
        )
        .bind(
          crypto.randomUUID(),
          '任务已保存。连接 ChatGPT 后即可启动执行。',
          now,
          id,
          user,
        ),
    ]);
    const task = await db
      .prepare(
        'SELECT id,title,prompt,model,project_id,status,created_at,updated_at FROM tasks WHERE owner_id=? AND request_id=?',
      )
      .bind(user, requestId)
      .first();
    if (
      task?.prompt !== prompt ||
      task.project_id !== projectId ||
      task.model !== model
    )
      throw new HttpError(409, '请求标识已用于另一项任务。');
    if (task && hasRuntime()) {
      const execution = await runtime(user, `/tasks/${task.id}`, 'POST', {
        action: 'start',
      }).catch(() => null);
      if (execution?.status) task.status = execution.status;
    }
    return { task };
  }, 201);
}
