import { spawnSync } from 'node:child_process';
const result = spawnSync(
  'npx',
  [
    'wrangler',
    'd1',
    'migrations',
    'apply',
    'DB',
    '--local',
    '--config',
    'wrangler.json',
    '--persist-to',
    process.env.LOCAL_STATE_PATH ?? '.wrangler/state',
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
