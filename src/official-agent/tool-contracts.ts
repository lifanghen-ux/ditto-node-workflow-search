import {createBenchmarkTools} from '../ditto/benchmark-tools.js';
import {PUBLIC_CHECK_OUTPUT_SCHEMA} from '../ditto/public-checks.js';
import {PUBLIC_PYTHON_OUTPUT_SCHEMA} from '../ditto/public-python-check.js';

/** Descriptor-only snapshot: constructing these registrations does not start a worker or execute a tool. */
export const STANDARD_TOOL_CONTRACTS=Object.freeze(createBenchmarkTools().map(tool=>({
 name:tool.name,description:tool.description,inputSchema:tool.inputSchema,
 successStructuredContentSchema:tool.name==='public_data_check'?PUBLIC_CHECK_OUTPUT_SCHEMA:tool.name==='public_python_check'?PUBLIC_PYTHON_OUTPUT_SCHEMA:tool.name==='bounded_arithmetic'
  ?{type:'object',properties:{result:{type:'number'}},additionalProperties:false}
  :{type:'object',properties:{count:{type:'integer'},truncated:{type:'boolean'},matches:{type:'array',items:{type:'object',properties:{position:{type:'integer'},snippet:{type:'string'}},additionalProperties:false}}},additionalProperties:false},
 notes:'Arguments follow inputSchema exactly. ACT.TOOL returns direct ExternalResult; structuredContent describes successful tool data, not a NodeResult.output. Errors are actual observations, not invented successful values.',
})));
