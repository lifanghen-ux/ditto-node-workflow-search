import type { GraphTransition } from '../domain.js';

/** Only topology is generated. Template implementations and configs are trusted code. */
export interface OrganizationSpec {
  readonly version: 1;
  readonly dataset: 'math' | 'automationbench';
  readonly nodes: readonly { readonly id: string; readonly template: string; readonly dependencies: readonly string[]; readonly feedback?: readonly string[] }[];
  readonly graphs: readonly { readonly id: string; readonly nodeIds: readonly string[] }[];
  readonly entryGraphId: string;
  readonly transitions: Readonly<Record<string, GraphTransition>>;
  readonly outputNodeId: string;
}
