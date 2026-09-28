import type { SearchTreeNode, WorkflowNodeSpec } from "../domain.js";
import { pathFingerprint } from "../workflow/spec.js";

export function pathTo(tree: ReadonlyMap<string, SearchTreeNode>, leafId: string): readonly SearchTreeNode[] {
  const reversed: SearchTreeNode[] = [];
  const visited = new Set<string>();
  let cursorId: string | null = leafId;
  while (cursorId !== null) {
    if (visited.has(cursorId)) throw new Error(`Search parent cycle detected at ${cursorId}`);
    visited.add(cursorId);
    const node = tree.get(cursorId);
    if (!node) throw new Error(`Unknown search tree Node: ${cursorId}`);
    reversed.push(node);
    cursorId = node.searchParentId;
  }
  return Object.freeze(reversed.reverse());
}

export function nodePathTo(tree: ReadonlyMap<string, SearchTreeNode>, leafId: string): readonly WorkflowNodeSpec[] {
  return Object.freeze(pathTo(tree, leafId).map((item) => item.node));
}

export function assertOneNodePerTreeEntry(tree: ReadonlyMap<string, SearchTreeNode>): void {
  let roots = 0;
  for (const [id, entry] of tree) {
    if (!entry.node || typeof entry.node !== "object" || Array.isArray(entry.node)) {
      throw new Error(`Search tree entry ${id} does not contain exactly one Ditto Node`);
    }
    if (entry.id !== id) throw new Error(`Search tree key ${id} does not match entry ID ${entry.id}`);
    if (entry.searchParentId === null) {
      roots++;
      if (entry.depth !== 0) throw new Error(`Search root ${id} must have depth zero`);
    } else {
      const parent = tree.get(entry.searchParentId);
      if (!parent) throw new Error(`Search tree entry ${id} has an unknown parent: ${entry.searchParentId}`);
      if (entry.depth !== parent.depth + 1) throw new Error(`Search tree entry ${id} has an invalid depth`);
    }
    const path = nodePathTo(tree, id);
    if (path.at(-1)?.id !== entry.node.id) throw new Error(`Search tree entry ${id} does not terminate in its stored Ditto Node`);
    if (pathFingerprint(path) !== entry.pathHash) throw new Error(`Search tree entry ${id} has an invalid path hash`);
  }
  if (tree.size && roots !== 1) throw new Error(`A search tree requires exactly one root; found ${roots}`);
}

/** Runtime-level prerequisites that are stricter than generic Graph topology. */
export function validateSearchPathSemantics(path: readonly WorkflowNodeSpec[]): void {
  const byId = new Map(path.map((node) => [node.id, node]));
  for (let index = 0; index < path.length; index++) {
    const node = path[index]!;
    const earlier = path.slice(0, index);
    if (node.type === "INFER.REASONING.REFLECT" && !earlier.some(isMessageProducer)) {
      throw new Error("REFLECT requires an earlier message-producing Ditto Node");
    }
    if (node.type === "INFER.REASONING.SAMPLE" && node.config.role === "finalizer" && !earlier.some(isMessageProducer)) {
      throw new Error("A finalizer SAMPLE requires an earlier message-producing Ditto Node");
    }
    if (node.type === "INFER.REASONING.DELIBERATE") {
      for (const dependency of node.dependencies) {
        const source = byId.get(dependency);
        if (!source || !isSolverCandidate(source)) {
          throw new Error(`DELIBERATE dependency ${dependency} must be a local solver candidate`);
        }
      }
    }
  }
}

function isMessageProducer(node: WorkflowNodeSpec): boolean {
  return node.type === "INFER.REASONING.TRAJECTORY"
    || node.type === "INFER.REASONING.DELIBERATE"
    || node.type === "INFER.REASONING.SAMPLE";
}

function isSolverCandidate(node: WorkflowNodeSpec): boolean {
  return node.type === "INFER.REASONING.TRAJECTORY"
    || (node.type === "INFER.REASONING.SAMPLE" && node.config.role === "solver");
}
