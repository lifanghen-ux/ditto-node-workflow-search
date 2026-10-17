import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { evaluationCodeHash } from './case-recovery.js';
import { PROTOCOL, GENERATION } from '../protocol.js';

async function javascriptTreeHash(directory: string, label: string): Promise<string> {
  const hash=createHash('sha256');
  async function visit(path:string, relative:string):Promise<void>{
    for(const e of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      if(e.isDirectory() && e.name!=='test')await visit(join(path,e.name),relative+'/'+e.name);
      else if(e.isFile() && e.name.endsWith('.js') && !e.name.endsWith('.test.js')){hash.update(relative+'/'+e.name);hash.update(await readFile(join(path,e.name)));}
    }
  }
  await visit(directory,label);return hash.digest('hex');
}
export async function builtCodeHash(root: string): Promise<string> { return javascriptTreeHash(join(root, "dist"), "dist"); }
export async function currentExecutionIdentity(root:string){
  const source=await evaluationCodeHash(root); const build=await builtCodeHash(root);
  const recorded=JSON.parse(await readFile(join(root,'dist/build-identity.json'),'utf8')) as {source:string;build:string};
  if(recorded.source!==source || recorded.build!==build)throw new Error('Source/build changed: run npm run build before search or test');
  const sdk=JSON.parse(await readFile(join(root,'node_modules/@codesoul-co/ditto/package.json'),'utf8')) as {version:string};
  const lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8')) as {packages:Record<string,{version?:string}>};
  if(sdk.version!==lock.packages['node_modules/@codesoul-co/ditto']?.version)throw new Error('Installed Ditto differs from the lockfile');
  return {version:1,source,build,dittoCode: await javascriptTreeHash(join(root,"node_modules/@codesoul-co/ditto/dist"), "ditto"),dittoVersion:sdk.version,nodeVersion:process.version,protocol:PROTOCOL,generation:GENERATION};
}
export function assertExecutionIdentity(frozen:unknown,current:unknown):void {
  if(!frozen || !isDeepStrictEqual(frozen,current))throw new Error('Frozen search execution identity differs from this code/build/runtime/protocol; re-search under the new version');
}
