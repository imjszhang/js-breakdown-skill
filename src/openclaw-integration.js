/**
 * OpenClaw Integration — High-level API for js-breakdown within OpenClaw.
 *
 * Combines js-breakdown's decomposition, ACP spawn instructions, and result
 * aggregation into a single, streamlined workflow that OpenClaw skills can
 * use directly.
 *
 * Workflow:
 *
 *   Step 1 ── breakdown(task)               → analysis + subtasks
 *   Step 2 ── generateDecompositionPlan()   → spawn instructions
 *   Step 3 ── OpenClaw executes spawn calls  → raw session results
 *   Step 4 ── parseAgentResults()            → aggregated markdown + summary
 *
 * Usage:
 *
 *   import { generateDecompositionPlan, parseAgentResults } from './openclaw-integration.js';
 *
 *   const plan = generateDecompositionPlan('Review all TS files for security issues');
 *   console.log(plan.planMarkdown);
 *   // → OpenClaw reads the plan, calls sessions_spawn for each subtask,
 *   //   collects results, then:
 *
 *   const { markdown, summary } = parseAgentResults(rawSessionResults);
 *   console.log(markdown);
 */

import { breakdown } from './breakdown.js';
import {
  generateSpawnInstructions,
  formatSpawnInstructions,
} from './acp-spawn.js';
import { aggregateResults } from './aggregation.js';
import { STRATEGY } from './breakdown.js';

// ── Aggregation strategy mapping ─────────────────────────────────────────

const AGGREGATION_FOR_STRATEGY = {
  [STRATEGY.BY_DIRECTORY]:   'concatenate',
  [STRATEGY.BY_FEATURE]:     'concatenate',
  [STRATEGY.BY_PERSPECTIVE]: 'merge-dedup',
  [STRATEGY.BY_PIPELINE]:    'summary',
};

// ── generateDecompositionPlan ────────────────────────────────────────────

/**
 * Generate a complete decomposition plan for OpenClaw.
 *
 * This is the primary entry point for OpenClaw skill integrations. It
 * analyzes the task, decomposes it into subtasks, and generates the exact
 * sessions_spawn calls that OpenClaw needs to execute.
 *
 * @param {string} task - Natural language task description.
 * @param {object} [options]
 * @param {number} [options.maxConcurrentSessions=8] - Hard cap on parallel agents.
 * @param {number} [options.defaultParallelism=4] - Default N when complexity is ambiguous.
 * @param {number} [options.minParallelism=2] - Minimum subtasks for any decomposition.
 * @param {string} [options.cwd] - Working directory (defaults to process.cwd()).
 * @param {string} [options.workDir='.js-breakdown'] - Shared workspace directory name.
 * @param {string} [options.taskType] - Force a specific decomposition strategy.
 * @returns {{
 *   analysis: {
 *     taskType: string,
 *     suggestedN: number,
 *     complexity: number,
 *     explicitItems: string[]|null
 *   },
 *   subtasks: Array<{
 *     id: string,
 *     description: string,
 *     strategy: string,
 *     target: string,
 *     prompt: string,
 *     order?: number
 *   }>,
 *   spawnInstructions: Array<object>,
 *   aggregationStrategy: string,
 *   planMarkdown: string
 * }}
 *
 * @example
 *   const plan = generateDecompositionPlan(
 *     'Review all TypeScript files in src/ for security vulnerabilities'
 *   );
 *
 *   console.log(plan.analysis.taskType);
 *   // → 'by-perspective'
 *
 *   console.log(plan.subtasks.length);
 *   // → 4 (or whatever suggestedN was)
 *
 *   // plan.spawnInstructions[0].sessionsSpawnCall:
 *   // {
 *   //   tool: 'sessions_spawn',
 *   //   description: 'Analyze from perspective: security',
 *   //   prompt: 'Review all TypeScript files...\n\n---\nFocus exclusively on the security perspective...',
 *   //   workDir: '/path/to/.js-breakdown/subtask-1',
 *   //   id: 'subtask-1',
 *   //   metadata: { strategy: 'by-perspective', target: 'security' }
 *   // }
 *
 *   console.log(plan.planMarkdown);
 *   // → Markdown document with full spawn instructions
 */
export function generateDecompositionPlan(task, options = {}) {
  const cwd = options.cwd || process.cwd();
  const workDir = options.workDir || '.js-breakdown';

  // Step 1: Analyze and decompose the task
  const { analysis, subtasks } = breakdown(task, options);

  // Step 2: Generate sessions_spawn instructions for each subtask
  const spawnInstructions = generateSpawnInstructions(subtasks, cwd, workDir);

  // Step 3: Determine the aggregation strategy
  const aggregationStrategy = options.aggregationStrategy
    || AGGREGATION_FOR_STRATEGY[analysis.taskType]
    || 'concatenate';

  // Step 4: Format the plan as markdown for the OpenClaw host to read
  const planMarkdown = [
    `# Decomposition Plan: ${task.length > 80 ? task.slice(0, 77) + '...' : task}`,
    '',
    '## Analysis',
    '',
    `- **Task type**: ${analysis.taskType}`,
    `- **Complexity**: ${analysis.complexity}/10`,
    `- **Suggested parallelism**: ${analysis.suggestedN} agents`,
    `- **Explicit items detected**: ${analysis.explicitItems ? analysis.explicitItems.join(', ') : 'none'}`,
    `- **Aggregation strategy**: ${aggregationStrategy}`,
    '',
    '## Subtasks',
    '',
    subtasks.map((st, i) => {
      const orderInfo = st.order !== undefined ? ` [order: ${st.order}]` : '';
      return `${i + 1}. **${st.id}** — ${st.description} (\`${st.strategy}\` → ${st.target})${orderInfo}`;
    }).join('\n'),
    '',
    '---',
    '',
    formatSpawnInstructions(spawnInstructions),
  ].join('\n');

  return {
    analysis,
    subtasks,
    spawnInstructions,
    aggregationStrategy,
    planMarkdown,
  };
}

// ── parseAgentResults ────────────────────────────────────────────────────

/**
 * Parse raw results from multiple agent sessions into a structured,
 * aggregated output.
 *
 * Call this after all sessions_spawn calls have completed. It normalizes
 * the raw results and runs the appropriate aggregation strategy to produce
 * a unified report.
 *
 * @param {Array<{
 *   id?: string,
 *   subtaskId?: string,
 *   description?: string,
 *   strategy?: string,
 *   target?: string,
 *   output?: string,
 *   result?: string,
 *   error?: string|null,
 *   durationMs?: number,
 *   duration?: number,
 *   order?: number
 * }>} rawResults - Results collected from sessions_spawn calls.
 *   Accepts flexible field names to work with different OpenClaw versions.
 * @param {object} [options]
 * @param {string} [options.aggregationStrategy] - Force a specific aggregation
 *   strategy ('concatenate', 'merge-dedup', or 'summary'). When omitted,
 *   the strategy is auto-detected from the first result's strategy field.
 * @param {boolean} [options.preserveFailures=false] - When true, failed
 *   subtasks appear in the output. When false, they are filtered out
 *   before aggregation.
 * @returns {{
 *   markdown: string,
 *   summary: {
 *     total: number,
 *     succeeded: number,
 *     failed: number,
 *     results: Array<{
 *       id: string,
 *       description: string,
 *       status: 'completed'|'failed',
 *       error?: string,
 *       durationMs: number
 *     }>
 *   }
 * }}
 *
 * @example
 *   // After all sessions_spawn calls complete, collect their results:
 *   const rawResults = [
 *     { id: 'subtask-1', description: 'Security review', strategy: 'by-perspective',
 *       target: 'security', output: 'Found 2 issues...', durationMs: 45000 },
 *     { id: 'subtask-2', description: 'Performance review', strategy: 'by-perspective',
 *       target: 'performance', output: 'Found 1 bottleneck...', durationMs: 32000 },
 *   ];
 *
 *   const { markdown, summary } = parseAgentResults(rawResults);
 *
 *   console.log(summary);
 *   // { total: 2, succeeded: 2, failed: 0, results: [...] }
 *
 *   console.log(markdown);
 *   // # Aggregated Findings (3 total, deduplicated)
 *   // ## Critical (1)
 *   // 1. **SQL injection risk** — ...
 *   // ## High (1)
 *   // ...
 */
export function parseAgentResults(rawResults, options = {}) {
  // Normalize results to the format expected by aggregateResults.
  // Handles both snake_case (from sessions_spawn output) and camelCase
  // (from the Orchestrator), plus OpenClaw-specific field names.
  const normalized = rawResults.map((r, i) => ({
    id: r.id || r.subtaskId || r.subtask_id || `result-${i}`,
    description: r.description || r.name || `Result ${i + 1}`,
    strategy: r.strategy || r.metadata?.strategy || null,
    target: r.target || r.metadata?.target || r.id || `item-${i}`,
    output: r.output || r.result || r.text || r.content || '',
    error: r.error || r.failure || null,
    durationMs: r.durationMs || r.duration || r.duration_ms || 0,
    order: r.order ?? r.metadata?.order,
  }));

  // Optionally filter out failed results
  const forAggregation = options.preserveFailures
    ? normalized
    : normalized.filter(r => !r.error);

  // Run the aggregation
  const markdown = aggregateResults(forAggregation, {
    strategy: options.aggregationStrategy,
  });

  // Build a structured summary
  const succeeded = normalized.filter(r => !r.error).length;
  const failed = normalized.filter(r => r.error).length;

  const summary = {
    total: normalized.length,
    succeeded,
    failed,
    results: normalized.map(r => ({
      id: r.id,
      description: r.description,
      status: r.error ? 'failed' : 'completed',
      ...(r.error ? { error: r.error } : {}),
      durationMs: r.durationMs,
    })),
  };

  return { markdown, summary };
}

// ── Quick integration helper ─────────────────────────────────────────────

/**
 * One-shot integration: decompose, generate spawn instructions, and return
 * everything needed for OpenClaw to execute the full workflow.
 *
 * This combines generateDecompositionPlan() with additional metadata that
 * helps OpenClaw understand the expected output format and how to feed
 * results back for parsing.
 *
 * @param {string} task - Natural language task description.
 * @param {object} [options] - Same options as generateDecompositionPlan().
 * @returns {object} Complete integration plan.
 */
export function createIntegrationPlan(task, options = {}) {
  const plan = generateDecompositionPlan(task, options);

  return {
    ...plan,

    // Instructions for the OpenClaw host agent
    instructions: {
      phase1: {
        description: 'Task decomposed. Subtasks are ready.',
        output: `${plan.subtasks.length} subtasks identified (strategy: ${plan.analysis.taskType}).`,
        data: plan.subtasks.map(st => ({
          id: st.id,
          description: st.description,
          target: st.target,
        })),
      },

      phase2: {
        description: `Spawn ${plan.subtasks.length} parallel sessions via sessions_spawn.`,
        action: 'For each entry in spawnInstructions, call sessions_spawn with the sessionsSpawnCall parameters.',
        parallelism: plan.subtasks.length,
        calls: plan.spawnInstructions.map(inst => inst.sessionsSpawnCall),
      },

      phase3: {
        description: 'Collect results from all sessions.',
        action: 'Gather the output from each sessions_spawn call. Keep track of which result belongs to which subtask ID.',
        expectedFields: ['id', 'description', 'output', 'strategy', 'target', 'durationMs'],
      },

      phase4: {
        description: 'Parse and aggregate results.',
        action: [
          'Pass the collected results to parseAgentResults(rawResults).',
          'Use the returned markdown as the final output.',
          'The summary object can be used for progress/status reporting.',
        ].join('\n'),
        code: [
          `import { parseAgentResults } from './src/openclaw-integration.js';`,
          ``,
          `const rawResults = [ /* collected from sessions_spawn */ ];`,
          `const { markdown, summary } = parseAgentResults(rawResults);`,
          `console.log(markdown);`,
          `// summary: { total: N, succeeded: X, failed: Y, results: [...] }`,
        ].join('\n'),
      },
    },
  };
}
