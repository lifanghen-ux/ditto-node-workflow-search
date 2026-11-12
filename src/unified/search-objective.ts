import type {FeedbackRecord} from './feedback.js';

export const SEARCH_OBJECTIVE_VERSION='quality-before-cost-v2-hypotheses';

/** Search policy data, derived from complete measurements rather than labels. */
export function searchObjective(history:readonly FeedbackRecord[],targetScore=1){
 const measured=history.filter(row=>row.status==='valid'&&row.evaluation?.valid===true);
 const scores=measured.map(row=>row.evaluation!.score);
 const best=scores.length?Math.max(...scores):null;
 const unresolved=best===null||best<targetScore;
 let withoutImprovement=0,previous=-Infinity;
 for(const score of scores){if(score>previous+1e-12){previous=score;withoutImprovement=0;}else withoutImprovement++;}
 return{version:SEARCH_OBJECTIVE_VERSION,targetScore,bestMeasuredScore:best,
  mode:unresolved?'quality-recovery':'cost-reduction',priority:['measured-quality','measured-cost'],
  consecutiveMeasurementsWithoutQualityImprovement:withoutImprovement,
  requirement:unresolved
   ?'Quality is unresolved. Propose a falsifiable change to the scored behavior. Successful tool execution is not proof of semantic task completion. Repeating a low-scoring business sequence does not show that it is correct: it reproduces the unresolved failure. Test a meaningfully different evidence-acquisition or completion criterion rather than rephrasing replies. Historical rationales are unverified optimizer hypotheses; do not inherit their claims as runtime facts. A cheaper unchanged failing execution is not a quality repair. Examine public requests, arguments and observations for missing evidence, ambiguous interpretations and premature completion; choose the mechanism yourself without private diagnoses or example-specific solution constants.'
   :'Preserve measured quality while reducing execution cost. A score target is a search stopping criterion, not proof of generalization or global optimality.'};
}
