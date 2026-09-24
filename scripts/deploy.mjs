import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (!existsSync('wrangler.json') || !existsSync('runtime/wrangler.json')) {
  console.error('先复制 wrangler.example.json 和 runtime/wrangler.example.json，再填写自己的资源 ID。');
  process.exit(1);
}
const config = JSON.parse(readFileSync('wrangler.json', 'utf8'));
const runtime = JSON.parse(readFileSync('runtime/wrangler.json', 'utf8'));
const unconfigured = (value) => !value || value.startsWith('YOUR_');
if (
  unconfigured(config.account_id) ||
  unconfigured(runtime.account_id) ||
  config.account_id !== runtime.account_id ||
  config.d1_databases.some((db) => unconfigured(db.database_id)) ||
  runtime.d1_databases.some((db) => unconfigured(db.database_id)) ||
  (!config.workers_dev && !config.routes?.length)
) {
  console.error(
    '部署前请配置真实 account_id、D1 ID，并启用 workers_dev 或自定义域名 route。',
  );
  process.exit(1);
}
if (
  unconfigured(config.vars.ACCESS_AUD) ||
  unconfigured(config.vars.ACCESS_TEAM_DOMAIN) ||
  unconfigured(runtime.vars.GITHUB_CLIENT_ID) ||
  unconfigured(runtime.vars.GITHUB_APP_SLUG) ||
  unconfigured(runtime.vars.PUBLIC_ORIGIN)
) {
  console.error('请先填写 Access、GitHub App 和 PUBLIC_ORIGIN 配置。');
  process.exit(1);
}
for (const [cmd, args] of [
  ['npm', ['run', 'build']],
  [
    'npx',
    [
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'DB',
      '--remote',
      '--config',
      'wrangler.json',
    ],
  ],
  ['npx', ['wrangler', 'deploy', '--config', 'runtime/wrangler.json']],
  ['npx', ['wrangler', 'deploy', '--config', 'dist/server/wrangler.json']],
]) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (cmd === 'npm' && args[1] === 'build') {
    const generated = 'dist/server/wrangler.json';
    const config = JSON.parse(readFileSync(generated, 'utf8'));
    delete config.legacy_env;
    writeFileSync(generated, JSON.stringify(config));
  }
}
