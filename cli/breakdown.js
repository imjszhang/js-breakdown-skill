#!/usr/bin/env node

/**
 * CLI entry point for js-breakdown.
 *
 * Usage:
 *   npx js-breakdown "Add dark mode to settings, dashboard, profile"
 *   echo "Review all TypeScript files for security" | npx js-breakdown
 *   npx js-breakdown --task "Refactor auth module" --max-agents 6 --dry-run
 *
 * Also usable as an OpenClaw skill via the --skill-mode flag.
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = new URL('..', import.meta.url).pathname;

// ── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { task: null, maxAgents: null, dryRun: false, json: false, help: false };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--task':
      case '-t':
        args.task = argv[++i];
        break;
      case '--max-agents':
      case '-n':
        args.maxAgents = parseInt(argv[++i], 10);
        break;
      case '--dry-run':
      case '--dry':
        args.dryRun = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (!a.startsWith('-') && !args.task) {
          args.task = a;
        }
    }
  }

  return args;
}

function showHelp() {
  console.log(`
js-breakdown — Break complex tasks into parallel subtasks

USAGE
  npx js-breakdown "task description"
  echo "task description" | npx js-breakdown
  npx js-breakdown --task "task description" [options]

OPTIONS
  --task, -t <text>     Task description
  --max-agents, -n <n>  Max concurrent agents (default: auto-detected)
  --dry-run, --dry      Only show decomposition plan, don't execute
  --json                Output results as JSON
  --help, -h            Show this help

EXAMPLES
  npx js-breakdown "Add dark mode to settings, dashboard, and profile"
  npx js-breakdown "Review all TS files in src/" --max-agents 6
  echo "Audit the API for security" | npx js-breakdown --dry-run

ENVIRONMENT
  JSBD_MAX_CONCURRENT   Max parallel agents (default: 8)
  JSBD_DEFAULT_PARALLEL Default parallelism (default: 4)
  JSBD_MIN_PARALLEL     Minimum subtasks (default: 2)
  JSBD_RETRY_COUNT      Retries per subtask (default: 2)
  JSBD_WORK_DIR         Workspace directory (default: .js-breakdown)
`.trim());
}

// ── Task input ──────────────────────────────────────────────────────────────

async function readStdin() {
  let input = '';
  const rl = createInterface({ input: process.stdin, output: null, terminal: false });
  for await (const line of rl) {
    input += line + '\n';
  }
  return input.trim();
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  // Load task from args, then stdin, then prompt
  let task = args.task;
  if (!task) {
    if (!process.stdin.isTTY) {
      task = await readStdin();
    }
  }
  if (!task) {
    console.error('Error: No task provided. Use --task or pipe a description.');
    console.error('Try: npx js-breakdown --help');
    process.exit(1);
  }

  // Config
  const maxConcurrentSessions = args.maxAgents
    || parseInt(process.env.JSBD_MAX_CONCURRENT, 10)
    || 8;

  const defaultParallelism = parseInt(process.env.JSBD_DEFAULT_PARALLEL, 10) || 4;
  const minParallelism = parseInt(process.env.JSBD_MIN_PARALLEL, 10) || 2;
  const retryCount = parseInt(process.env.JSBD_RETRY_COUNT, 10) || 2;
  const workDir = process.env.JSBD_WORK_DIR || '.js-breakdown';

  // Import core modules
  const { analyzeTask, decompose, breakdown } = await import('../src/breakdown.js');
  const { Orchestrator, cliSpawnFn, mockSpawnFn } = await import('../src/orchestrator.js');
  const { aggregateResults } = await import('../src/aggregation.js');

  // Step 1: Analyze
  const analysis = analyzeTask(task, {
    maxConcurrentSessions,
    defaultParallelism,
    minParallelism,
  });

  if (args.json && args.dryRun) {
    const subtasks = decompose(task, analysis.suggestedN, {
      taskType: analysis.taskType,
      explicitItems: analysis.explicitItems,
    });

    console.log(JSON.stringify({ analysis, subtasks }, null, 2));
    process.exit(0);
  }

  console.log([
    '╔══════════════════════════════════════════╗',
    '║         js-breakdown skill               ║',
    '╚══════════════════════════════════════════╝',
    '',
    `Task:        ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}`,
    `Strategy:    ${analysis.taskType}`,
    `Complexity:  ${analysis.complexity}/10`,
    `Agents:      ${analysis.suggestedN} (max concurrent: ${maxConcurrentSessions})`,
    analysis.explicitItems ? `Items:       ${analysis.explicitItems.join(', ')}` : '',
    '',
  ].join('\n'));

  // Step 2: Decompose
  const subtasks = decompose(task, analysis.suggestedN, {
    taskType: analysis.taskType,
    explicitItems: analysis.explicitItems,
  });

  console.log('Subtasks:');
  for (const st of subtasks) {
    console.log(`  [${st.id}] ${st.description}  (${st.strategy})`);
  }
  console.log('');

  if (args.dryRun) {
    console.log('Dry run — no agents spawned.');
    process.exit(0);
  }

  // Step 3: Orchestrate
  const cwd = process.cwd();
  console.log(`Spawning ${subtasks.length} agent sessions (cwd: ${relative(process.cwd(), cwd) || '.'})...\n`);

  const orchestrator = new Orchestrator({
    spawnFn: cliSpawnFn,
    maxConcurrent: maxConcurrentSessions,
    retryCount,
    workDir,
  });

  orchestrator.on('session:start', ({ id, description }) => {
    console.log(`  [${id}] Starting: ${description}`);
  });
  orchestrator.on('session:done', ({ id, durationMs }) => {
    console.log(`  [${id}] Done (${(durationMs / 1000).toFixed(1)}s)`);
  });
  orchestrator.on('session:retry', ({ id, attempt, error }) => {
    console.log(`  [${id}] Retry ${attempt}: ${error}`);
  });
  orchestrator.on('session:fail', ({ id, error }) => {
    console.log(`  [${id}] FAILED: ${error}`);
  });

  const results = await orchestrator.spawnParallelSessions(subtasks, cwd);

  // Step 4: Aggregate
  console.log('\n' + '─'.repeat(60));
  console.log('AGGREGATED RESULTS');
  console.log('─'.repeat(60) + '\n');

  const aggregated = aggregateResults(results);
  console.log(aggregated);

  // Optionally output JSON
  if (args.json) {
    console.log('\n--- JSON OUTPUT ---\n');
    console.log(JSON.stringify({
      analysis,
      subtasks,
      results: [...results.values()],
    }, null, 2));
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
