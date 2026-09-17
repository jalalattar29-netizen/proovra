import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const bootstrap = new URL('../../../services/api/test/setup/test-bootstrap.mjs', import.meta.url).href;

test('API test preload never inspects repository env files, including for fingerprints', () => {
  const code = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const attempts = [];
    for (const name of ['existsSync', 'readFileSync']) {
      const original = fs[name];
      fs[name] = function (path, ...args) {
        if (/(^|[\\\\/])\\.env(?:$|\\.)/.test(String(path))) {
          attempts.push(name);
          if (name === 'existsSync') return true;
          return 'BOOTSTRAP_FILE_ONLY_CANARY=fixture-only-canary';
        }
        return original.call(this, path, ...args);
      };
    }
    syncBuiltinESMExports();
    process.env.BOOTSTRAP_INHERITED_CANARY = 'fixture-inherited-canary';
    const mod = await import(${JSON.stringify(bootstrap)});
    process.stdout.write(JSON.stringify({
      attempts,
      inheritedRecognized: mod.isMachineSuppliedValue('BOOTSTRAP_INHERITED_CANARY', 'fixture-inherited-canary'),
      testValueRecognized: mod.isMachineSuppliedValue('BOOTSTRAP_INHERITED_CANARY', 'new-test-value'),
      fileValueRecognized: mod.isMachineSuppliedValue('BOOTSTRAP_FILE_ONLY_CANARY', 'fixture-only-canary'),
      bootstrapped: process.env.PROOVRA_ENV_BOOTSTRAPPED,
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', timeout: 10000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key))),
  });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.deepEqual(actual.attempts, [], 'No env file metadata or contents may be inspected');
  assert.equal(actual.inheritedRecognized, true);
  assert.equal(actual.testValueRecognized, false);
  assert.equal(actual.fileValueRecognized, false);
  assert.equal(actual.bootstrapped, '1');
});
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const apiRequire = createRequire(new URL('../../../services/api/package.json', import.meta.url));
const prismaConfig = new URL('../../../services/api/prisma.config.ts', import.meta.url).href;
test('Prisma configuration never reads env files in a bootstrapped fixture', () => {
  const code = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const attempts = [];
    for (const name of ['existsSync', 'readFileSync']) {
      const original = fs[name];
      fs[name] = function (path, ...args) {
        if (/(^|[\\\\/])\\.env(?:$|\\.)/.test(String(path))) {
          attempts.push(name);
          if (name === 'existsSync') return true;
          return 'PRISMA_FILE_ONLY_CANARY=fixture-only-canary';
        }
        return original.call(this, path, ...args);
      };
    }
    syncBuiltinESMExports();
    process.env.PROOVRA_ENV_BOOTSTRAPPED = '1';
    process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:1/config_test';
    await import(${JSON.stringify(prismaConfig)});
    process.stdout.write(JSON.stringify({attempts, leaked: process.env.PRISMA_FILE_ONLY_CANARY ?? null}));
  `;
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(apiRequire.resolve('tsx/esm')).href, '--input-type=module', '-e', code], {
    encoding: 'utf8', timeout: 10000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key))),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {attempts: [], leaked: null});
});
