import { owner, route, writeGuard } from '@/lib/server';
import { runtime, hasRuntime } from '@/lib/runtime';
export async function GET() {
  return route(async () => {
    const user = await owner();
    return hasRuntime()
      ? runtime(user, '/connection')
      : { status: 'disconnected' };
  });
}
export async function POST(request: Request) {
  return route(async () => {
    writeGuard(request);
    return runtime(await owner(), '/connection', 'POST', {});
  });
}
export async function DELETE(request: Request) {
  return route(async () => {
    writeGuard(request);
    return runtime(await owner(), '/connection', 'DELETE', {});
  });
}
