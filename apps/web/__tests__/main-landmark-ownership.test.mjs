import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const ts=createRequire(path.join(root,'services/api/package.json'))('typescript');
// Every authenticated page and every component. Only the shell and the
// surfaces reviewed as rendering OUTSIDE it may own a main landmark; the
// system-state component claims role="main" only when no shell owns one
// (MainLandmarkContext), which the render suite pins.
const nestedRoots=['apps/web/app/(app)','apps/web/components'];
const OUTSIDE_THE_SHELL=new Set(['apps/web/components/app-shell-v2/AppShellV2.tsx','apps/web/components/marketing/page-shell/MarketingPage.tsx']);
function files(p){const s=fs.statSync(p);if(s.isDirectory())return path.basename(p)==='node_modules'?[]:fs.readdirSync(p).flatMap(n=>files(path.join(p,n)));return p.endsWith('.tsx')&&!OUTSIDE_THE_SHELL.has(path.relative(root,p).split(path.sep).join('/'))?[p]:[];}
function tags(file){const sf=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const hits=[];function visit(n){if((ts.isJsxOpeningElement(n)||ts.isJsxSelfClosingElement(n))&&n.tagName.getText(sf)==='main')hits.push(n);if(ts.isJsxAttribute(n)&&n.name.getText(sf)==='role'&&n.initializer&&/^["']main["']$/.test(n.initializer.getText(sf)))hits.push(n);ts.forEachChild(n,visit);}visit(sf);return hits;}
test('authenticated pages and their shared surfaces defer main ownership to the shell',()=>{
 const hits=nestedRoots.flatMap(p=>files(path.join(root,p))).flatMap(f=>tags(f).map(()=>path.relative(root,f)));
 assert.deepEqual(hits,[]);
 assert.equal(tags(path.join(root,'apps/web/components/app-shell-v2/AppShellV2.tsx')).length,1);
});
