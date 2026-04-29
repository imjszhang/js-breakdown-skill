# js-breakdown

An OpenClaw skill that breaks any task into multiple subtasks executed in parallel by Claude Code agents via ACP.

## Architecture (v2)

**Key change from v1:** The skill no longer does regex-based strategy detection. Instead, the OpenClaw Agent (with LLM semantic understanding) makes all decomposition decisions, and js-breakdown acts as a pure parallel task scheduler.

```
┌──────────────────────────────────────────────┐
│  OpenClaw Agent (LLM)                        │
│  - Understands task semantics               │
│  - Reads project file structure             │
│  - Decides: strategy, N, file assignments   │
│  - Writes precise, context-aware prompts    │
└────────────┬─────────────────────────────────┘
             │ subtask plans (JSON)
             ▼
┌──────────────────────────────────────────────┐
│  js-breakdown skill (scheduler)              │
│  - Spawns parallel agent sessions            │
│  - Manages concurrency & retries             │
│  - Aggregates results by strategy            │
└──────────────────────────────────────────────┘
```

**How it works:**
1. Agent analyzes task, reads project tree, decides decomposition strategy
2. Agent writes precise subtask prompts (with file paths, scope boundaries, acceptance criteria)
3. js-breakdown spawns agents in parallel, monitors progress, retries failures
4. Results are aggregated by strategy (concatenate / merge-dedup / pipeline summary)

## Installation

```bash
npm install -g js-breakdown
```

Requires Node.js 18+ and the Claude Code CLI (`claude`) on your PATH.

## Usage

### Agent-Driven Mode (recommended)

The OpenClaw Agent analyzes the task and passes pre-computed subtask plans to js-breakdown for execution:

```bash
# Agent provides subtask plans as JSON
npx js-breakdown --subtasks '[
  {
    "id": "subtask-1",
    "description": "Add dark mode to settings",
    "strategy": "by-feature",
    "target": "settings",
    "prompt": "Add dark mode support to src/components/settings/...\nOnly modify files under src/components/settings/..."
  },
  {
    "id": "subtask-2",
    "description": "Add dark mode to dashboard",
    "strategy": "by-feature",
    "target": "dashboard",
    "prompt": "Add dark mode support to src/components/dashboard/..."
  }
]'

# Or from a file
npx js-breakdown --subtasks-file ./decomposition-plan.json

# Dry-run to see the plan
npx js-breakdown --subtasks-file ./plan.json --dry-run
```

### Legacy Mode (regex-based, no LLM needed)

```bash
npx js-breakdown --legacy "Add dark mode to settings, dashboard, and profile"
echo "Review all TypeScript files for security" | npx js-breakdown --legacy
```

### OpenClaw Skill

When installed as an OpenClaw skill, invoke it with:

```
/breakdown "Audit the API for security vulnerabilities"
```

The Agent will follow the workflow in SKILL.md: analyze the task, read project structure, decide the decomposition, present the plan, spawn agents, and aggregate results.

### Options

| Flag | Env Variable | Description |
|------|-------------|-------------|
| `--task` / `-t` | — | Task description (legacy mode) |
| `--legacy` | — | Use regex-based decomposition (no LLM) |
| `--subtasks` | — | Pre-computed subtask JSON (agent-driven) |
| `--subtasks-file` | — | Read subtasks from JSON file |
| `--max-agents` / `-n` | `JSBD_MAX_CONCURRENT` | Max parallel agents (default: 8) |
| `--dry-run` / `--dry` | — | Show plan without spawning agents |
| `--json` | — | Output JSON along with formatted results |
| `--help` / `-h` | — | Show help |

## Decomposition Strategies

The Agent chooses from four strategies based on task shape:

| Strategy | Best For | Splitting Method |
|----------|----------|-----------------|
| **by-directory** | File/directory-scoped work | Assign each subtask a specific directory |
| **by-feature** | Feature/module development | Assign each subtask a specific feature or module |
| **by-perspective** | Multi-angle analysis | Each subtask reviews the same code from a different quality angle |
| **by-pipeline** | Sequential stages | Split pipeline into ordered stages |

## Architecture

```
SKILL.md              ← Agent workflow: Steps 1-8 (see SKILL.md for details)
cli/breakdown.js      ← CLI entry point (agent-driven + --legacy fallback)
src/
  breakdown.js        ← [DEPRECATED] analyzeTask() + decompose() — legacy fallback
  orchestrator.js     ← spawns + manages parallel ACP sessions (concurrency, retry)
  aggregation.js      ← merges results by strategy (concatenate, merge-dedup, summary)
  acp-spawn.js        ← ACP sessions_spawn instruction generator
  openclaw-integration.js ← High-level OpenClaw integration API
```

### Using the API Directly

```js
import { Orchestrator, cliSpawnFn } from 'js-breakdown/src/orchestrator.js';
import { aggregateResults } from 'js-breakdown/src/aggregation.js';

// Subtask plans come from the Agent (LLM analysis, not regex)
const subtasks = [
  {
    id: 'subtask-1',
    description: 'Add dark mode to settings',
    strategy: 'by-feature',
    target: 'settings',
    prompt: 'Add dark mode to src/components/settings/...',
  },
  {
    id: 'subtask-2',
    description: 'Add dark mode to dashboard',
    strategy: 'by-feature',
    target: 'dashboard',
    prompt: 'Add dark mode to src/components/dashboard/...',
  },
];

// Execute subtasks in parallel
const orchestrator = new Orchestrator({ spawnFn: cliSpawnFn });
const results = await orchestrator.runAll(subtasks, process.cwd());

// Aggregate results
const output = aggregateResults(results);
console.log(output);
```

### Legacy API (--legacy only)

```js
import { breakdown } from 'js-breakdown';

// Uses regex-based strategy detection — generic prompts, no project context
const { analysis, subtasks } = breakdown('Audit the API for security issues');
```

### OpenClaw Integration

```js
import { generateDecompositionPlan, parseAgentResults } from 'js-breakdown/src/openclaw-integration.js';

// Generate spawn instructions for the Agent
const plan = generateDecompositionPlan('Review all TS files for security issues');
console.log(plan.planMarkdown);

// Parse results after all sessions complete
const { markdown, summary } = parseAgentResults(rawSessionResults);
```

## License

MIT
