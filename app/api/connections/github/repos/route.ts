import { owner, route } from '@/lib/server';
import { runtime } from '@/lib/runtime';
export async function GET() {
  return route(async () => runtime(await owner(), '/github/repos'));
}
