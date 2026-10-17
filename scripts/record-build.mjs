import { writeFile } from 'node:fs/promises';
import { evaluationCodeHash } from '../dist/run/case-recovery.js';
import { builtCodeHash } from '../dist/run/execution-identity.js';
const source=await evaluationCodeHash(process.cwd());
const build=await builtCodeHash(process.cwd());
await writeFile('dist/build-identity.json',JSON.stringify({source,build})+'\n');
