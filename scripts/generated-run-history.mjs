import {readFile,readdir,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';

const optionalJson=async (path,fallback)=>{
  try{return JSON.parse(await readFile(path,'utf8'));}
  catch(error){if(error.code==='ENOENT')return fallback;throw error;}
};
const optionalRows=async path=>{
  try{return (await readFile(path,'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);}
  catch(error){if(error.code==='ENOENT')return [];throw error;}
};

/** Full public events already live in JSONL; never duplicate them in snapshots. */
export function compactRunHistory(history,directory) {
  return history.map(({traces,...record})=>({...record,traceEvidence:record.traceEvidence??{
    directory:resolve(directory),candidateId:record.id,
  }}));
}

/** Recover legacy oversized snapshots from the unchanged canonical artifacts. */
export async function readRunHistory(directory,{maxEmbeddedHistoryBytes=64*1024*1024}={}) {
  const path=join(directory,'history.json');
  if((await stat(path)).size<=maxEmbeddedHistoryBytes)return JSON.parse(await readFile(path,'utf8'));
  const history=[];
  for(const file of (await readdir(join(directory,'candidates'))).filter(name=>name.endsWith('.json')).sort()) {
    const id=file.slice(0,-5),saved=await optionalJson(join(directory,'candidates',file),null);
    const proposal=saved.proposal??saved,root=join(directory,'evaluations',id);
    const summary=await optionalJson(join(root,'summary.json'),{});
    const results=[...new Map([
      ...await optionalRows(join(root,'samples.jsonl')),...await optionalRows(join(root,'live-samples.jsonl')),
      ...await optionalRows(join(root,'regraded-samples.jsonl')),
    ].map(row=>[row.caseId,row])).values()];
    const valid=results.length>0&&results.every(row=>row.valid&&!row.error);
    history.push({id,proposal,rationale:proposal.rationale,referenceCandidateId:proposal.referenceCandidateId??null,
      status:valid?'valid':'invalid',evaluation:{...summary,valid,examples:results.length,repeats:1,
        score:valid?results.reduce((sum,row)=>sum+row.score,0)/results.length:0,results},
      engineeringFeedback:[...new Set(results.filter(row=>row.error).map(row=>row.error))],
      traceEvidence:{directory:resolve(directory),candidateId:id},historyRecoveredFrom:'canonical-candidate-and-case-artifacts'});
  }
  return history;
}
