import type { RegisteredTool } from '@codesoul-co/ditto/worker/interaction';
import type { JsonObject } from '@codesoul-co/ditto/contracts';
import { BFCL_TOOLS, bfclScope } from '../benchmark/bfcl.js';
import {BFCL_COMPLETION_CHECKS_SCHEMA,BfclCompletionLedger} from './bfcl-completion.js';
import {PublicCheckInputError} from './public-checks.js';

/** Tools are bound to one official conversation, never a process-global world. */
export function createBfclTools(): readonly RegisteredTool[] {
  const session=bfclScope.getStore();if(!session)return [];
  const ledger=new BfclCompletionLedger();
  let lastPublic:Record<string,unknown>={};
  return session.tools.map(descriptor=>({
    name:descriptor.name,description:descriptor.name==='bfcl_respond'?'Submit the current turn. Optional completionChecks compare declared targets with real observations before submitting; a failed check keeps this turn open. bfcl_call executionEvidence supplies turn-local callIndex and parsed values. Checks must use the last business observation in the current turn; after intervening calls obtain a final readback. Checks certify only the declared conditions.':descriptor.description??'Official BFCL conversation interface',
    inputSchema:(descriptor.name==='bfcl_respond'?{...descriptor.inputSchema,properties:{...(descriptor.inputSchema as any).properties,completionChecks:BFCL_COMPLETION_CHECKS_SCHEMA}}:descriptor.inputSchema) as JsonObject,
    effects:descriptor.name==='bfcl_state'?['read']:['read','write'],
    validate(args){if(!args||typeof args!=='object'||Array.isArray(args))throw Error('BFCL tool arguments must be an object');},
    async execute(args){
      if(bfclScope.getStore()!==session||!(BFCL_TOOLS as readonly string[]).includes(descriptor.name))throw Error('BFCL tool invoked outside its registered conversation');
      session.assertHealthy();
      let forwarded=args,completionCheck:JsonObject|undefined;
      if(descriptor.name==='bfcl_respond'&&Object.hasOwn(args,'completionChecks')){
        try{completionCheck=ledger.check(args.turn,args.completionChecks);}
        catch(error){if(!(error instanceof PublicCheckInputError))throw error;completionCheck={passed:false,issue:error.message};}
        if(completionCheck.passed!==true){
          const rejected={...lastPublic,complete:false,error:'COMPLETION_CHECK_FAILED: declared targets were not established by the actual observations; this turn was not submitted.',completionCheck};
          return{status:'success',content:JSON.stringify(rejected),structuredContent:rejected as JsonObject};
        }
        const {completionChecks:_checks,...rest}=args;forwarded=rest;
      }
      const official=await session.call(descriptor.name,forwarded);
      const executionEvidence=descriptor.name==='bfcl_call'?ledger.record(args,official):undefined;
      const result={...official,...(executionEvidence?{executionEvidence}:{}),...(completionCheck?{completionCheck}:{})};
      lastPublic=structuredClone(official);
      // Domain errors remain actual observations; transport faults throw above.
      return{status:'success',content:JSON.stringify(result),structuredContent:result as JsonObject};
    },
  }));
}
