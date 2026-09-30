import type {
  AgentPlanSpec,
  EvaluationSummary,
  NodeProposal,
  SearchExperience,
  SearchTreeNode,
  WorkflowNodeSpec,
} from "../domain.js";
import {
  createInitialSampleNode,
  createRootNode,
  createSearchTreeNode,
  instantiateProposal,
  isRunnableNodePath,
  materializeAgentPlan,
  nextNodeId,
  pathFingerprint,
  validateNodePath,
} from "../workflow/spec.js";
import { backpropagateEvaluation } from "./backprop.js";
import { checkAFlowConvergence } from "./convergence.js";
import { ProposalValidationError, type NextNodeProposer } from "./proposer.js";
import { SeededRandom } from "./random.js";
import { compareRunnableLeaves, selectParent } from "./selector.js";
import { assertOneNodePerTreeEntry, nodePathTo, pathTo, validateSearchPathSemantics } from "./tree.js";

export interface SearchCallbacks {
  /** Called once for every created search vertex. Experience exists only for an evaluated runnable path. */
  node(node: SearchTreeNode, experience: SearchExperience | null, plan?: AgentPlanSpec): Promise<void>;
  event(value: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface SearchResult {
  readonly nodes: readonly SearchTreeNode[];
  readonly experiences: readonly SearchExperience[];
  readonly bestLeaf: SearchTreeNode;
  readonly bestPlan: AgentPlanSpec;
  readonly bestPath: readonly SearchTreeNode[];
  readonly stoppedBecause: "max-rounds" | "converged";
}

export interface NodeWorkflowSearchOptions {
  readonly evaluate: (plan: AgentPlanSpec) => Promise<EvaluationSummary>;
  readonly proposer: Pick<NextNodeProposer, "propose">;
  readonly callbacks?: Partial<SearchCallbacks>;
  readonly seed: number;
  /** Number of one-Node expansion attempts after the baseline path. */
  readonly rounds: number;
  readonly topK: number;
  /** Number of unchanged Top-3 aggregate transitions before AFlow convergence. */
  readonly patience: number;
  readonly maxDepth?: number;
  readonly taskGoal?: string;
  readonly initialInstruction?: string;
}

/**
 * Search tree whose every vertex is exactly one real Ditto Node.
 *
 * A path is materialized into Graphs and one Loop only when it is runnable.
 * Scores are then propagated to every Node on that path.
 */
export class NodeWorkflowSearch {
  readonly #evaluate: (plan: AgentPlanSpec) => Promise<EvaluationSummary>;
  readonly #proposer: Pick<NextNodeProposer, "propose">;
  readonly #callbacks: SearchCallbacks;
  readonly #random: SeededRandom;
  readonly #rounds: number;
  readonly #topK: number;
  readonly #patience: number;
  readonly #maxDepth: number;
  readonly #taskGoal: string;
  readonly #initialInstruction: string | undefined;

  constructor(options: NodeWorkflowSearchOptions) {
    integer(options.rounds, "rounds", 1, 100_000);
    integer(options.topK, "topK", 1, 10_000);
    integer(options.patience, "patience", 1, 10_000);
    const maxDepth = options.maxDepth ?? 12;
    integer(maxDepth, "maxDepth", 1, 23);
    this.#evaluate = options.evaluate;
    this.#proposer = options.proposer;
    this.#callbacks = {
      node: options.callbacks?.node ?? (async () => undefined),
      event: options.callbacks?.event ?? (async () => undefined),
    };
    this.#random = new SeededRandom(options.seed);
    this.#rounds = options.rounds;
    this.#topK = options.topK;
    this.#patience = options.patience;
    this.#maxDepth = maxDepth;
    this.#taskGoal = options.taskGoal ?? "Improve held-out task performance while keeping the Ditto workflow small and reliable.";
    this.#initialInstruction = options.initialInstruction;
  }

  async run(): Promise<SearchResult> {
    const tree = new Map<string, SearchTreeNode>();
    const experiences: SearchExperience[] = [];
    const seenPaths = new Set<string>();

    const rootSpec = createRootNode();
    const rootPath = Object.freeze([rootSpec]);
    const root = createSearchTreeNode("search-000", null, 0, rootSpec, rootPath);
    tree.set(root.id, root);
    seenPaths.add(root.pathHash);
    await this.#callbacks.node(root, null);
    await this.#callbacks.event({
      type: "node-created",
      searchNodeId: root.id,
      parentSearchNodeId: null,
      nodeType: root.node.type,
      runnable: false,
    });

    const initialSpec = createInitialSampleNode(this.#initialInstruction);
    const initialPath = Object.freeze([...rootPath, initialSpec]);
    validateSearchPathSemantics(initialPath);
    const initial = createSearchTreeNode("search-001", root.id, 1, initialSpec, initialPath);
    tree.set(initial.id, initial);
    seenPaths.add(initial.pathHash);
    const initialPlan = materializeAgentPlan(initial.id, initialPath);
    const initialEvaluation = await this.#evaluate(initialPlan);
    const initialExperience = experienceFor(initial, initialEvaluation, null, true);
    experiences.push(initialExperience);
    backpropagateEvaluation(tree, initial.id, initialEvaluation);
    let bestLeafId = initial.id;
    let bestPlan = initialPlan;
    await this.#callbacks.node(requiredNode(tree, initial.id), initialExperience, initialPlan);
    await this.#callbacks.event({
      type: "baseline-evaluated",
      searchNodeId: initial.id,
      score: initialEvaluation.score,
    });

    const evaluationHistory: EvaluationSummary[] = [initialEvaluation];
    let completedRounds = 0;
    let proposalFailures = 0;
    let nextSearchIndex = 2;
    let stoppedBecause: SearchResult["stoppedBecause"] = "max-rounds";

    // Format/duplicate rejections regenerate inside a round. As in frozen
    // AFlow's outer loop, optimizer/provider exceptions consume a search slot.
    while (completedRounds < this.#rounds) {
      const round = completedRounds + 1;
      const frontier = [...tree.values()].filter((node) =>
        node.evaluation !== undefined && node.depth < this.#maxDepth,
      );
      if (!frontier.length) break;
      const parent = selectParent(frontier, this.#topK, this.#random);
      const parentPath = nodePathTo(tree, parent.id);
      let instantiated: WorkflowNodeSpec | undefined;
      let proposedPath: readonly WorkflowNodeSpec[] | undefined;

      await this.#callbacks.event({
        type: "parent-selected",
        round,
        searchNodeId: parent.id,
        nodeType: parent.node.type,
        meanScore: parent.statistics.meanScore,
        visits: parent.statistics.visits,
      });

      let proposal: NodeProposal;
      try {
        const validateProposal = (value: NodeProposal): {
          readonly node: WorkflowNodeSpec;
          readonly path: readonly WorkflowNodeSpec[];
        } => {
          const node = instantiateProposal(value, nextNodeId(parentPath, value.type));
          const path = Object.freeze([...parentPath, node]);
          validateNodePath(path);
          validateSearchPathSemantics(path);
          if (!isRunnableNodePath(path)) throw new ProposalValidationError("A candidate must produce a complete answer");
          const fingerprint = pathFingerprint(path);
          if (seenPaths.has(fingerprint)) throw new ProposalValidationError("The proposed Node path has already been evaluated or expanded");
          return { node, path };
        };
        proposal = await this.#proposer.propose({
          path: parentPath,
          experiences: relevantExperiences(parent.id, tree, experiences),
          taskGoal: this.#taskGoal,
          validate: (value) => void validateProposal(value),
        });
        // Never trust a custom proposer to have called the callback, or to return
        // the same value it validated. Validate the returned proposal again.
        const validated = validateProposal(proposal);
        instantiated = validated.node;
        proposedPath = validated.path;
      } catch (error) {
        await this.#callbacks.event({
          type: "proposal-failed",
          round,
          parentSearchNodeId: parent.id,
          error: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof ProposalValidationError) {
          if (++proposalFailures >= 100) throw new Error("100 invalid proposals: search requires attention; no fabricated fallback was evaluated");
        } else {
          completedRounds++;
        }
        continue;
      }
      proposalFailures = 0;

      const searchNodeId = `search-${String(nextSearchIndex++).padStart(3, "0")}`;
      const child = createSearchTreeNode(
        searchNodeId,
        parent.id,
        parent.depth + 1,
        instantiated,
        proposedPath,
      );
      tree.set(child.id, child);
      seenPaths.add(child.pathHash);
      assertOneNodePerTreeEntry(tree);

      if (!isRunnableNodePath(proposedPath)) {
        await this.#callbacks.node(child, null);
        await this.#callbacks.event({
          type: "partial-path-created",
          round,
          searchNodeId: child.id,
          parentSearchNodeId: parent.id,
          nodeType: child.node.type,
        });
        continue;
      }

      const plan = materializeAgentPlan(child.id, proposedPath);
      let evaluation: EvaluationSummary;
      try {
        evaluation = await this.#evaluate(plan);
      } catch (error) {
        await this.#callbacks.node(child, null, plan);
        await this.#callbacks.event({
          type: "evaluation-failed",
          round,
          searchNodeId: child.id,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const parentReference = directOrMeanScore(parent);
      const experience = experienceFor(child, evaluation, parentReference, false);
      completedRounds++;
      evaluationHistory.push(evaluation);
      experiences.push(experience);
      backpropagateEvaluation(tree, child.id, evaluation);
      const evaluatedChild = requiredNode(tree, child.id);
      await this.#callbacks.node(evaluatedChild, experience, plan);
      await this.#callbacks.event({
        type: "path-evaluated",
        round,
        searchNodeId: child.id,
        parentSearchNodeId: parent.id,
        nodeType: child.node.type,
        score: evaluation.score,
        delta: experience.delta,
      });

      const bestLeaf = requiredNode(tree, bestLeafId);
      if (compareRunnableLeaves(evaluatedChild, bestLeaf) < 0) {
        bestLeafId = evaluatedChild.id;
        bestPlan = plan;
      }

      const convergence = checkAFlowConvergence(evaluationHistory, 3, 0, this.#patience);
      await this.#callbacks.event({
        type: "convergence-checked",
        round: completedRounds,
        topK: 3,
        z: 0,
        topKMean: convergence.topKMean,
        unchangedTransitions: convergence.unchangedTransitions,
        converged: convergence.converged,
      });
      if (convergence.converged) {
        stoppedBecause = "converged";
        break;
      }
    }

    assertOneNodePerTreeEntry(tree);
    const bestLeaf = requiredNode(tree, bestLeafId);
    return Object.freeze({
      nodes: Object.freeze([...tree.values()]),
      experiences: Object.freeze([...experiences]),
      bestLeaf,
      bestPlan,
      bestPath: pathTo(tree, bestLeaf.id),
      stoppedBecause,
    });
  }
}

/** Compatibility name for the command layer; semantics are now Node-level. */
export { NodeWorkflowSearch as WorkflowSearch };

function experienceFor(
  node: SearchTreeNode,
  evaluation: EvaluationSummary,
  parentReference: number | null,
  baseline: boolean,
): SearchExperience {
  const delta = parentReference === null ? null : evaluation.score - parentReference;
  return Object.freeze({
    searchNodeId: node.id,
    parentSearchNodeId: node.searchParentId,
    node: node.node,
    score: evaluation.score,
    delta,
    outcome: baseline || parentReference === null
      ? "root"
      : delta! > 0
        ? "improved"
        : delta! < 0
          ? "regressed"
          : "tied",
    failures: Object.freeze(evaluation.results
      .filter((item) => item.score === 0)
      .slice(0, 5)
      .map((item) => ({
        caseId: item.caseId,
        prediction: item.prediction,
        expected: item.expected,
        ...(item.error ? { error: item.error } : {}),
      }))),
  });
}

function relevantExperiences(
  parentId: string,
  tree: ReadonlyMap<string, SearchTreeNode>,
  experiences: readonly SearchExperience[],
): readonly SearchExperience[] {
  const ancestors = new Set(pathTo(tree, parentId).map((item) => item.id));
  return experiences.filter((item) =>
    ancestors.has(item.searchNodeId)
    || item.parentSearchNodeId === parentId,
  );
}

function directOrMeanScore(node: SearchTreeNode): number | null {
  if (node.evaluation) return node.evaluation.score;
  return node.statistics.visits ? node.statistics.meanScore : null;
}

function requiredNode(tree: ReadonlyMap<string, SearchTreeNode>, id: string): SearchTreeNode {
  const value = tree.get(id);
  if (!value) throw new Error(`Unknown search tree Node: ${id}`);
  return value;
}

function integer(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer in [${minimum}, ${maximum}]`);
  }
}
