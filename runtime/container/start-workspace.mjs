import { spawn } from 'node:child_process';
const daemon = spawn('/usr/local/bin/computerd', [], { stdio: 'inherit' });
let bridge;
function stop(code = 0) {
  bridge?.kill('SIGTERM');
  daemon.kill('SIGTERM');
  process.exit(code);
}
daemon.on('error', () => stop(1));
daemon.on('exit', (code) => stop(code || 1));
process.on('SIGTERM', () => stop());
let ready = false;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch('http://127.0.0.1:8080/health')).ok) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!ready) stop(1);
bridge = spawn(process.execPath, ['/opt/cloudagent/bridge.mjs'], {
  stdio: 'inherit',
});
bridge.on('error', () => stop(1));
bridge.on('exit', (code) => stop(code || 1));
