import { env } from 'cloudflare:workers';
export function getDb(): D1Database {
  if (!env.DB) throw new Error('任务存储暂时不可用，请稍后重试。');
  return env.DB;
}
