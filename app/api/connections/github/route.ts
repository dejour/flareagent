import { owner, route, writeGuard } from '@/lib/server';
import { runtime } from '@/lib/runtime';
export async function GET() {
  return route(async () => runtime(await owner(), '/github'));
}
export async function POST(request: Request) {
  return route(async () => {
    writeGuard(request);
    return runtime(await owner(), '/github', 'POST', {});
  });
}
export async function DELETE(request: Request) {
  return route(async () => {
    writeGuard(request);
    return runtime(await owner(), '/github', 'DELETE', {});
  });
}
