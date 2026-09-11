import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const requireApi = createRequire(new URL('../../../services/api/package.json', import.meta.url));
const configUrl = new URL('../e2e/admin-control-plane/playwright.config.ts', import.meta.url).href;
const osEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key)));

for (const [name, options, expected] of [
  ['custom port', { PROOVRA_FIXTURE_WEB_PORT: '3317' }, 'http://localhost:3317'],
  ['explicit origin', { PROOVRA_FIXTURE_WEB_PORT: '3317', PROOVRA_FIXTURE_WEB_BASE: 'http://127.0.0.1:3317' }, 'http://127.0.0.1:3317'],
]) {
  test(`admin workers inherit the server origin: ${name}`, () => {
    const script = `const { default: config } = await import(${JSON.stringify(configUrl)});
      console.log(JSON.stringify({worker:process.env.PROOVRA_FIXTURE_WEB_BASE,
        browser:config.use.baseURL,ready:config.webServer.url,
        api:process.env.PROOVRA_FIXTURE_API_BASE}));`;
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(requireApi.resolve('tsx/esm')).href,
      '--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 10000,
      env: { ...osEnv, ...options, PROOVRA_FIXTURE_API_BASE: 'http://localhost:8197' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {worker:expected,browser:expected,ready:`${expected}/login`,api:'http://localhost:8197'});
  });
}
