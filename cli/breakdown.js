#!/usr/bin/env node

/**
 * CLI entry point for js-breakdown.
 *
 * **v2 架构变更:** 默认模式是 agent-driven。OpenClaw Agent 负责分析任务、
 * 读取项目结构、决定拆分策略、编写 subtask prompt。CLI 负责执行（spawn +
 * monitor + aggregate）。
 *
 * Usage (agent-driven — recommended):
 *   # Agent passes pre-computed subtask plans via --subtasks
 *   npx js-breakdown --subtasks '[{"id":"s1","description":"...","prompt":"..."}]'
 *   npx js-breakdown --subtasks-file ./plan.json
 *
 * Usage (legacy — regex-based, no LLM needed):
 *   npx js-breakdown --legacy "Add dark mode to settings, dashboard, profile"
 *   echo "Review all TypeScript files for security" | npx js-breakdown --legacy
 *
 * Also usable as an OpenClaw skill via the --skill-mode flag.
 */

import { createInterface } from 'node:readline';
import { relative } from 'node:path';
import { readFile } from 'node:fs/promises';

// ── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    task: null,
    maxAgents: null,
    dryRun: false,
    json: false,
    help: false,
    legacy: false,
    subtasks: null,
    subtasksFile: null,
  };

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
      case '--legacy':
        args.legacy = true;
        break;
      case '--subtasks':
        args.subtasks = argv[++i];
        break;
      case '--subtasks-file':
        args.subtasksFile = argv[++i];
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

USAGE (agent-driven — recommended)
  npx js-breakdown --subtasks <json>         Subtask plans from Agent (JSON string)
  npx js-breakdown --subtasks-file <path>    Subtask plans from file

USAGE (legacy — regex-based, no LLM needed)
  npx js-breakdown --legacy "task description"
  echo "task description" | npx js-breakdown --legacy

OPTIONS
  --task, -t <text>       Task description (required for --legacy mode)
  --legacy                Use regex-based decomposition (no LLM needed)
  --subtasks <json>       Pre-computed subtask plans in JSON (agent-driven)
  --subtasks-file <path>  Read subtask plans from a JSON file
  --max-agents, -n <n>    Max concurrent agents (default: 8)
  --dry-run, --dry        Only show decomposition plan, don't execute
  --json                  Output results as JSON
  --help, -h              Show this help

EXAMPLES (agent-driven)
  npx js-breakdown --subtasks '[{"id":"s1","description":"settings","strategy":"by-feature","target":"settings","prompt":"Add dark mode to settings..."}]'
  npx js-breakdown --subtasks-file ./decomposition-plan.json --max-agents 4

EXAMPLES (legacy)
  npx js-breakdown --legacy "Add dark mode to settings, dashboard, and profile"
  echo "Audit the API for security" | npx js-breakdown --legacy --dry-run

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

// ── Load subtasks from agent-provided sources ───────────────────────────────

/**
 * 从 --subtasks 或 --subtasks-file 加载 Agent 预先计算好的 subtask 计划。
 * 这是 agent-driven 模式的入口：Agent 已经完成了语义分析，CLI 只负责执行。
 */
async function loadSubtasksFromArgs(args) {
  if (args.subtasks) {
    try {
      return JSON.parse(args.subtasks);
    } catch (e) {
      console.error(`Error: Invalid --subtasks JSON: ${e.message}`);
      process.exit(1);
    }
  }

  if (args.subtasksFile) {
    try {
      const content = await readFile(args.subtasksFile, 'utf-8');
      return JSON.parse(content);
    } catch (e) {
      console.error(`Error: Could not read --subtasks-file "${args.subtasksFile}": ${e.message}`);
      process.exit(1);
    }
  }

  return null;
}

// ── Validate subtask structure ──────────────────────────────────────────────

/**
 * 验证 Agent 提供的 subtask 数组是否符合要求的格式。
 */
function validateSubtasks(subtasks) {
  if (!Array.isArray(subtasks)) {
    return 'Subtasks must be an array';
  }
  if (subtasks.length === 0) {
    return 'Subtasks array is empty';
  }
  for (let i = 0; i < subtasks.length; i++) {
    const st = subtasks[i];
    if (!st.id) return `subtask[${i}]: missing required field "id"`;
    if (!st.description) return `subtask[${i}]: missing required field "description"`;
    if (!st.prompt) return `subtask[${i}]: missing required field "prompt"`;
    // strategy 和 target 有默认值
    if (!st.strategy) st.strategy = 'by-feature';
    if (!st.target) st.target = st.id;
  }
  return null;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  // Config
  const maxConcurrentSessions = args.maxAgents
    || parseInt(process.env.JSBD_MAX_CONCURRENT, 10)
    || 8;

  const defaultParallelism = parseInt(process.env.JSBD_DEFAULT_PARALLEL, 10) || 4;
  const minParallelism = parseInt(process.env.JSBD_MIN_PARALLEL, 10) || 2;
  const retryCount = parseInt(process.env.JSBD_RETRY_COUNT, 10) || 2;
  const workDir = process.env.JSBD_WORK_DIR || '.js-breakdown';

  // ── Agent-driven mode: use pre-computed subtasks ─────────────────────
  // Agent 已经完成了语义分析和任务拆分，CLI 直接跳到执行阶段。

  const agentSubtasks = await loadSubtasksFromArgs(args);

  if (agentSubtasks) {
    // 验证 Agent 提供的 subtask 格式
    const validationError = validateSubtasks(agentSubtasks);
    if (validationError) {
      console.error(`Error: Invalid subtask plan: ${validationError}`);
      process.exit(1);
    }

    const { Orchestrator, cliSpawnFn, mockSpawnFn } = await import('../src/orchestrator.js');
    const { aggregateResults } = await import('../src/aggregation.js');

    console.log([
      '╔══════════════════════════════════════════╗',
      '║   js-breakdown (agent-driven mode)       ║',
      '╚══════════════════════════════════════════╝',
      '',
      `Subtasks:    ${agentSubtasks.length}`,
      `Max concurrent: ${maxConcurrentSessions}`,
      '',
    ].join('\n'));

    if (args.dryRun) {
      console.log('Subtasks (from Agent plan):');
      for (const st of agentSubtasks) {
        console.log(`  [${st.id}] ${st.description}  (${st.strategy || 'by-feature'})`);
      }
      console.log('\nDry run — no agents spawned.');
      process.exit(0);
    }

    // 打印 subtask 列表
    console.log('Subtasks (from Agent plan):');
    for (const st of agentSubtasks) {
      console.log(`  [${st.id}] ${st.description}  (${st.strategy || 'by-feature'})`);
    }
    console.log('');

    const cwd = process.cwd();
    console.log(`Spawning ${agentSubtasks.length} agent sessions (cwd: ${relative(process.cwd(), cwd) || '.'})...\n`);

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

    const results = await orchestrator.spawnParallelSessions(agentSubtasks, cwd);

    // Aggregate
    console.log('\n' + '─'.repeat(60));
    console.log('AGGREGATED RESULTS');
    console.log('─'.repeat(60) + '\n');

    const aggregated = aggregateResults(results);
    console.log(aggregated);

    if (args.json) {
      console.log('\n--- JSON OUTPUT ---\n');
      console.log(JSON.stringify({
        subtasks: agentSubtasks,
        results: [...results.values()],
      }, null, 2));
    }

    process.exit(0);
  }

  // ── Legacy mode: regex-based decomposition ────────────────────────────
  // 仅在 --legacy 标志下使用旧的基于正则的管道。
  // agent-driven 模式是默认推荐模式。

  if (!args.legacy && !agentSubtasks) {
    // 既没有 --legacy 也没有 --subtasks：引导用户使用 agent-driven 模式
    console.log([
      'js-breakdown v2 — agent-driven mode is now the default.',
      '',
      'The recommended workflow:',
      '  1. OpenClaw Agent analyzes your task (understands semantics, reads project)',
      '  2. Agent decides the decomposition plan (strategy, N, file assignments)',
      '  3. Agent passes the subtask plans to js-breakdown for execution',
      '',
      'To use the new agent-driven mode:',
      '  npx js-breakdown --subtasks \'[{...}]\'',
      '  npx js-breakdown --subtasks-file ./plan.json',
      '',
      'To use the legacy regex-based mode:',
      '  npx js-breakdown --legacy "your task description"',
      '',
      'See --help for more details.',
    ].join('\n'));
    process.exit(0);
  }

  // Legacy mode: load task from args, stdin, or prompt
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

  // Import core modules (legacy)
  const { analyzeTask, decompose, breakdown } = await import('../src/breakdown.js');
  const { Orchestrator, cliSpawnFn, mockSpawnFn } = await import('../src/orchestrator.js');
  const { aggregateResults } = await import('../src/aggregation.js');

  // Step 1: Analyze (legacy regex-based)
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
    '║   js-breakdown (legacy mode)             ║',
    '╚══════════════════════════════════════════╝',
    '',
    `Task:        ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}`,
    `Strategy:    ${analysis.taskType}`,
    `Complexity:  ${analysis.complexity}/10`,
    `Agents:      ${analysis.suggestedN} (max concurrent: ${maxConcurrentSessions})`,
    analysis.explicitItems ? `Items:       ${analysis.explicitItems.join(', ')}` : '',
    '',
  ].join('\n'));

  // Step 2: Decompose (legacy regex-based)
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
