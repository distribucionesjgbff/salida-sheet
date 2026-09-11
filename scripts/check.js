import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function check(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = `${path}/${entry.name}`;
    if (entry.isDirectory()) await check(name);
    else if (name.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', name], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
for (const path of ['src','scripts','test']) await check(path);
console.log('JavaScript syntax OK');
