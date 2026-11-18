import type {DatasetName} from '../domain.js';

/** Adapter-owned scoring interface, never task answers or private diagnostics. */
export const PUBLIC_EVALUATION_CONTRACT_VERSION='public-evaluation-interface-v1';
export function publicEvaluationContract(dataset:DatasetName){
 const common={version:PUBLIC_EVALUATION_CONTRACT_VERSION,dataset,scope:'Public adapter semantics only; no reference values, hidden assertions or checker diagnoses.'};
 if(dataset==='bfcl')return{...common,scoredArtifact:'executed-official-world-snapshot',finalAnswerProjectionScored:false,
  measurement:'The official multi-turn checker replays the saved per-turn business calls and checks execution responses and business state. bfcl_respond submits a turn and reveals the next public turn; final Graph/Loop text does not submit a turn.',
  invariant:'Identical saved world snapshots receive the same grade regardless of the final Graph/Loop answer string. Rewriting or accumulating only that string cannot repair an unchanged business execution.'};
 if(dataset==='automationbench')return{...common,scoredArtifact:'official-world-state',finalAnswerProjectionScored:false,
  measurement:'The official task evaluator checks actual business effects in the saved environment, not an assistant claim of completion.'};
 if(dataset==='mbpp'||dataset==='humaneval')return{...common,scoredArtifact:'extracted-python-implementation',finalAnswerProjectionScored:true,
  measurement:'The adapter extracts the implementation and executes the unchanged private tests in Docker. Comments or explanations do not substitute for function behavior. Hidden assertions and expected values are not available to workflow optimization.'};
 return{...common,scoredArtifact:'final-answer-text',finalAnswerProjectionScored:true,
  measurement:dataset==='drop'?'The unchanged DROP scorer compares the final answer text with reference alternatives using normalized token F1. Low F1 alone does not identify a reasoning defect.':'The unchanged dataset scorer evaluates the final answer text.'};
}
