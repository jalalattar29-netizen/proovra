import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const ts=createRequire(path.join(root,'services/api/package.json'))('typescript');
const nestedRoots=['apps/web/app/(app)','apps/web/components/governance-experience','apps/web/components/workspace-admin','apps/web/components/command-center','apps/web/components/navigation/PageRouteGate.tsx'];
function files(p){const s=fs.statSync(p);return s.isDirectory()?fs.readdirSync(p).flatMap(n=>files(path.join(p,n))):p.endsWith('.tsx')?[p]:[];}
function tags(file){const sf=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const hits=[];function visit(n){if((ts.isJsxOpeningElement(n)||ts.isJsxSelfClosingElement(n))&&n.tagName.getText(sf)==='main')hits.push(n);ts.forEachChild(n,visit);}visit(sf);return hits;}
test('authenticated pages and their shared surfaces defer main ownership to the shell',()=>{
 const hits=nestedRoots.flatMap(p=>files(path.join(root,p))).flatMap(f=>tags(f).map(()=>path.relative(root,f)));
 assert.deepEqual(hits,[]);
 assert.equal(tags(path.join(root,'apps/web/components/app-shell-v2/AppShellV2.tsx')).length,1);
});
