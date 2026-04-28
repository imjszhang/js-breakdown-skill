/**
 * ACP Spawn Integration for OpenClaw.
 *
 * Bridges js-breakdown's task decomposition with OpenClaw's sessions_spawn
 * tool. Since sessions_spawn is an OpenClaw tool (not a Node.js module), this
 * module generates structured instructions that OpenClaw follows to spawn
 * parallel Claude Code sessions.
 *
 * Architecture:
 *
 *   ┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
 *   │  breakdown() │ ──▶ │ acp-spawn.js     │ ──▶ │ sessions_spawn  │
 *   │  (subtasks)  │     │ (generates spawn │     │ (OpenClaw tool  │
 *   │              │     │  instructions)   │     │  invocations)   │
 *   └──────────────┘     └──────────────────┘     └─────────────────┘
 *
 * Usage (inside OpenClaw skill context):
 *
 *   import { breakdown } from './breakdown.js';
 *   import { generateSpawnInstructions, formatSpawnInstructions } from './acp-spawn.js';
 *
 *   const { subtasks } = breakdown('Review all TypeScript files for security issues');
 *   const instructions = generateSpawnInstructions(subtasks, process.cwd());
 *
 *   // Format as markdown for the OpenClaw agent to read and execute:
 *   const plan = formatSpawnInstructions(instructions);
 *   console.log(plan);
 *   // → OpenClaw reads this and calls sessions_spawn for each subtask
 *
 * Advanced — Orchestrator-compatible spawn function:
 *
 *   import { createAcpSpawnFn } from './acp-spawn.js';
 *   import { Orchestrator } from './orchestrator.js';
 *
 *   const spawnFn = createAcpSpawnFn({
 *     onSpawn: (subtask, workDir, resolve, reject) => {
 *       // OpenClaw host calls sessions_spawn here and feeds back the result
 *     }
 *   });
 *   const orch = new Orchestrator({ spawnFn });
 *   // orch.spawnParallelSessions(subtasks, cwd);
 */

import path from 'node:path';

// ── Core: generate structured spawn instructions ──────────────────────────

/**
 * Generate structured sessions_spawn instructions for OpenClaw.
 *
 * Each instruction describes exactly what sessions_spawn call OpenClaw
 * should make for one subtask, including the full prompt, working directory,
 * and metadata needed for result aggregation.
 *
 * @param {object[]} subtasks - Subtask plans from breakdown.decompose().
 *   Each subtask has: id, description, strategy, target, prompt, order?
 * @param {string} cwd - Working directory for the skill invocation.
 * @param {string} [workDir='.js-breakdown'] - Shared workspace directory name.
 * @returns {Array<{
 *   subtaskId: string,
 *   description: string,
 *   strategy: string,
 *   target: string,
 *   order: number|undefined,
 *   workDir: string,
 *   prompt: string,
 *   sessionsSpawnCall: {
 *     tool: 'sessions_spawn',
 *     description: string,
 *     prompt: string,
 *     workDir: string,
 *     id: string,
 *     metadata: { strategy: string, target: string, order: number|undefined }
 *   }
 * }>}
 */
export function generateSpawnInstructions(subtasks, cwd, workDir = '.js-breakdown') {
  return subtasks.map(st => {
    const sessionWorkDir = path.join(cwd, workDir, st.id);

    return {
      subtaskId: st.id,
      description: st.description,
      strategy: st.strategy,
      target: st.target,
      order: st.order,
      workDir: sessionWorkDir,
      prompt: st.prompt,

      // The exact sessions_spawn call that OpenClaw should make.
      // The host agent reads this, calls sessions_spawn with these
      // parameters, and collects the session result.
      sessionsSpawnCall: {
        tool: 'sessions_spawn',
        description: st.description,
        prompt: st.prompt,
        workDir: sessionWorkDir,
        id: st.id,
        metadata: {
          strategy: st.strategy,
          target: st.target,
          order: st.order,
        },
      },
    };
  });
}

// ── Orchestrator-compatible spawn factory ─────────────────────────────────

/**
 * Create an ACP-aware spawn function compatible with the Orchestrator.
 *
 * Since sessions_spawn is an OpenClaw tool (not callable from Node.js),
 * the returned spawn function uses a deferred pattern:
 *
 *   1. When spawnFn(subtask, workDir) is called, it immediately returns a
 *      session handle with a pending `wait()` promise.
 *   2. It notifies the host (via onSpawn callback or EventEmitter) that a
 *      session needs spawning.
 *   3. The host makes the actual sessions_spawn call.
 *   4. When the session completes, the host calls handle._resolve(result)
 *      or handle._reject(error), which resolves the pending `wait()`.
 *
 * This allows the Orchestrator to manage concurrency and retries while the
 * actual spawning is handled externally by OpenClaw.
 *
 * @param {object} [options]
 * @param {import('node:events').EventEmitter} [options.emitter] -
 *   EventEmitter that will receive 'spawn-request' events.
 * @param {Function} [options.onSpawn] -
 *   Called as onSpawn(subtask, workDir, resolve, reject) for each spawn.
 *   The host should call resolve(result) or reject(error) when the
 *   sessions_spawn call completes.
 * @param {Function} [options.writePrompt] -
 *   Called as writePrompt(workDir, subtask) to write the prompt file.
 *   Defaults to no-op (OpenClaw sessions_spawn receives the prompt inline).
 * @returns {Function} spawnFn(subtask, workDir) => Promise<SessionHandle>
 */
export function createAcpSpawnFn(options = {}) {
  const { emitter, onSpawn, writePrompt } = options;

  /**
   * Spawn a single subtask as an ACP session.
   *
   * @param {object} subtask - Subtask plan from breakdown.decompose()
   * @param {string} workDir - Working directory for this session
   * @returns {Promise<{ wait: () => Promise<string>, subtask: object, workDir: string, _resolve: Function, _reject: Function }>}
   */
  return async (subtask, workDir) => {
    // Create a deferred promise — wait() blocks until resolve/reject is called
    let resolveWait;
    let rejectWait;
    const waitPromise = new Promise((resolve, reject) => {
      resolveWait = resolve;
      rejectWait = reject;
    });

    const handle = {
      subtask,
      workDir,
      wait: () => waitPromise,

      // Called by the OpenClaw host when the sessions_spawn call completes.
      // Not part of the public SessionHandle contract — used internally
      // by the integration bridge.
      _resolve: resolveWait,
      _reject: rejectWait,
    };

    // Optionally write the prompt to the work directory (useful when
    // sessions_spawn expects a file-based prompt).
    if (writePrompt) {
      await writePrompt(workDir, subtask);
    }

    // Notify the host that a session needs spawning
    if (onSpawn) {
      onSpawn(subtask, workDir, resolveWait, rejectWait);
    }

    if (emitter) {
      emitter.emit('spawn-request', {
        subtask,
        workDir,
        handle,
        resolve: resolveWait,
        reject: rejectWait,
      });
    }

    return handle;
  };
}

// ── Single-subtask spawn function ────────────────────────────────────────

/**
 * The ACP spawn function for a single subtask.
 *
 * Returns a session handle with a deferred `wait()` method. The actual
 * sessions_spawn call must be made by the OpenClaw host, which then feeds
 * the result back via `handle._resolve(result)` or `handle._reject(error)`.
 *
 * This is the lowest-level spawn primitive. It's useful when you want to
 * spawn sessions one at a time with full control, rather than going through
 * the Orchestrator.
 *
 * @param {object} subtask - A single subtask plan from breakdown.decompose()
 * @param {string} workDir - Working directory for this session
 * @returns {Promise<{
 *   subtask: object,
 *   workDir: string,
 *   prompt: string,
 *   description: string,
 *   wait: () => Promise<string>,
 *   _resolve: (result: string) => void,
 *   _reject: (error: Error) => void
 * }>}
 *
 * @example
 *   const handle = await acpSpawnFn(subtask, '/tmp/work/subtask-1');
 *
 *   // The host (OpenClaw) reads handle.prompt and calls sessions_spawn:
 *   //   sessions_spawn(description: handle.description,
 *   //                  prompt: handle.prompt,
 *   //                  workDir: handle.workDir,
 *   //                  id: subtask.id)
 *
 *   // When the session completes, the host feeds back the result:
 *   //   handle._resolve(sessionOutput);
 *
 *   // Meanwhile, anyone awaiting handle.wait() gets the result:
 *   const result = await handle.wait();
 */
export async function acpSpawnFn(subtask, workDir) {
  let resolveWait;
  let rejectWait;
  const waitPromise = new Promise((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });

  return {
    subtask,
    workDir,
    prompt: subtask.prompt,
    description: subtask.description,
    wait: () => waitPromise,

    // Deferred resolution — called by the OpenClaw host
    _resolve: resolveWait,
    _reject: rejectWait,
  };
}

// ── Formatting helpers ───────────────────────────────────────────────────

/**
 * Format spawn instructions as a human-readable markdown document.
 *
 * The output is designed to be read by the OpenClaw host agent, which
 * follows the instructions to make the actual sessions_spawn calls.
 *
 * @param {object[]} instructions - From generateSpawnInstructions()
 * @param {object} [options]
 * @param {boolean} [options.verbose=false] - Include full prompts in output
 * @returns {string} Markdown formatted spawn plan
 */
export function formatSpawnInstructions(instructions, options = {}) {
  const { verbose = false } = options;

  const lines = [
    '# Parallel Session Spawn Plan',
    '',
    `**${instructions.length} sessions** to spawn in parallel:`,
    '',
    '| # | ID | Strategy | Target | Description |',
    '|---|----|----------|--------|-------------|',
  ];

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];
    const desc = inst.description.length > 60
      ? inst.description.slice(0, 57) + '...'
      : inst.description;
    const orderInfo = inst.order !== undefined ? ` (order: ${inst.order})` : '';
    lines.push(
      `| ${i + 1} | \`${inst.subtaskId}\` | ${inst.strategy} | ${inst.target} | ${desc}${orderInfo} |`
    );
  }

  lines.push('');

  for (const inst of instructions) {
    const orderNote = inst.order !== undefined
      ? ` (pipeline stage ${inst.order + 1})`
      : '';

    lines.push(
      `## ${inst.subtaskId}: ${inst.description}${orderNote}`,
      '',
      `- **Strategy**: ${inst.strategy}`,
      `- **Target**: ${inst.target}`,
      `- **WorkDir**: \`${inst.workDir}\``,
    );

    if (verbose) {
      lines.push(
        '',
        '### sessions_spawn call',
        '',
        '```',
        `sessions_spawn(`,
        `  description: "${inst.description.replace(/"/g, '\\"')}",`,
        `  prompt: """`,
        inst.prompt.split('\n').map(l => `    ${l}`).join('\n'),
        `  """,`,
        `  workDir: "${inst.workDir}",`,
        `  id: "${inst.subtaskId}",`,
        `  metadata: {`,
        `    strategy: "${inst.strategy}",`,
        `    target: "${inst.target}",`,
        inst.order !== undefined ? `    order: ${inst.order},` : '',
        `  }`,
        `)`,
        '```',
      );
    } else {
      lines.push(
        '',
        '### sessions_spawn call',
        '',
        '```',
        `sessions_spawn(`,
        `  description: "${inst.description.replace(/"/g, '\\"')}",`,
        `  prompt: """`,
        `    [Full prompt — ${inst.prompt.length} chars. Use --verbose to see full content]`,
        `  """,`,
        `  workDir: "${inst.workDir}",`,
        `  id: "${inst.subtaskId}"`,
        `)`,
        '```',
      );
    }

    lines.push('');
  }

  lines.push(
    '---',
    '',
    '## After All Sessions Complete',
    '',
    'Collect the results and parse them via:',
    '',
    '```js',
    `import { parseAgentResults } from './src/openclaw-integration.js';`,
    '',
    `const results = [`,
    `  // session results from sessions_spawn calls...`,
    `];`,
    '',
    `const { markdown, summary } = parseAgentResults(results);`,
    `console.log(markdown);`,
    '```',
    '',
  );

  return lines.join('\n');
}

/**
 * Format spawn instructions as a compact JSON object suitable for
 * programmatic consumption by the OpenClaw host.
 *
 * @param {object[]} instructions - From generateSpawnInstructions()
 * @returns {object} Compact spawn plan
 */
export function formatSpawnInstructionsJson(instructions) {
  return {
    totalSessions: instructions.length,
    sessions: instructions.map(inst => ({
      id: inst.subtaskId,
      description: inst.description,
      strategy: inst.strategy,
      target: inst.target,
      order: inst.order,
      sessionsSpawnCall: inst.sessionsSpawnCall,
    })),
  };
}
