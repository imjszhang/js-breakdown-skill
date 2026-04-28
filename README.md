# js-breakdown

An OpenClaw skill that breaks any task into multiple subtasks executed in parallel by Claude Code agents via ACP.

## Concept

You give it a task — it figures out how to split it into N independent pieces, spawns N Claude Code sessions in parallel, and aggregates the results.

```
Input:  "Add dark mode to settings, dashboard, and profile page"
Output: 3 parallel agents → aggregated result

        ┌──────────────────┐
        │   Decomposer     │
        │  (analyze +      │
        │   decompose)     │
        └───┬──┬──┬──┬────┘
            │  │  │  │
    ┌───────┘  │  │  └───────┐
    ▼          ▼  ▼          ▼
 Agent 1   Agent 2 ... Agent N
 (ACP)     (ACP)       (ACP)
    │          │          │
    └──────────┴──────────┘
               │
        ┌──────▼──────┐
        │  Aggregator │
        └──────┬──────┘
               ▼
         Final Output
```

## Installation

```bash
npm install -g js-breakdown
# or
npx js-breakdown "your task"
```

Requires Node.js 18+ and the Claude Code CLI (`claude`) on your PATH.

## Usage

### CLI (standalone)

```bash
# Direct task
npx js-breakdown "Review all TypeScript files in src/ for security issues"

# Via pipe
echo "Add unit tests for auth, billing, and profile modules" | npx js-breakdown

# Options
npx js-breakdown \
  --task "Refactor the entire codebase" \
  --max-agents 6 \
  --dry-run
```

### OpenClaw Skill

When installed as an OpenClaw skill, invoke it with:

```
/skill:breakdown "Audit the API for security vulnerabilities"
```

Or with options:

```
/skill:breakdown --task "Write tests for every module in lib/" --max-agents 8
```

### Options

| Flag | Env Variable | Description |
|------|-------------|-------------|
| `--task` / `-t` | — | Task description (not needed if first positional arg) |
| `--max-agents` / `-n` | `JSBD_MAX_CONCURRENT` | Max parallel agents |
| `--dry-run` / `--dry` | — | Show decomposition plan without spawning agents |
| `--json` | — | Output JSON along with formatted results |
| `--help` / `-h` | — | Show help |

## How It Works

### 1. Task Analysis

The decomposer classifies the task into one of four strategies:

| Strategy | When Used | Example |
|----------|-----------|---------|
| **by-directory** | Working on files/paths | "Lint all JS files in src/" |
| **by-feature** | Working on modules/features | "Add dark mode to settings, dashboard, profile" |
| **by-perspective** | Multi-angle analysis | "Audit the API for vulnerabilities" |
| **by-pipeline** | Sequential stages | "Migrate database and update data models" |

### 2. Dynamic N Calculation

Parallelism isn't fixed at 4. The decomposer determines optimal N based on:
- **Explicit items**: If the task lists "settings, dashboard, profile" → N = 3
- **Complexity score**: Longer, more technical tasks get higher N
- **Diminishing returns cap**: N never exceeds `maxConcurrentSessions` (default 8)
- **Minimum**: Never decomposes into fewer than 2 subtasks

### 3. Parallel Execution

Subtasks run as independent Claude Code sessions via ACP. Each session:
- Gets a self-contained prompt with clear scope boundaries
- Works in its own subdirectory under `.js-breakdown/`
- Has no knowledge of other agents (file-based coordination only)

### 4. Result Aggregation

Strategy-appropriate merging:
- **by-directory / by-feature**: Concatenated with section headers
- **by-perspective**: Merged and deduplicated by finding signature
- **by-pipeline**: Stage-by-stage summary in dependency order

## Examples

See the [`examples/`](./examples/) directory for full walkthroughs:
- [Code review](./examples/code-review.md): Review a multi-module codebase
- [Feature development](./examples/feature-dev.md): Build features across multiple components
- [Research analysis](./examples/research.md): Multi-perspective analysis

## Architecture

```
cli/breakdown.js     ← CLI entry point (args → pipeline)
src/
  breakdown.js       ← analyzeTask() + decompose() — the "brain"
  orchestrator.js    ← spawns + manages parallel ACP sessions
  aggregation.js     ← merges results by strategy
```

### Using the API Directly

```js
import { breakdown } from 'js-breakdown';
import { Orchestrator, cliSpawnFn } from 'js-breakdown/src/orchestrator.js';
import { aggregateResults } from 'js-breakdown/src/aggregation.js';

const { analysis, subtasks } = breakdown('Audit the API for security issues');
// analysis = { taskType: 'by-perspective', suggestedN: 4, complexity: 7, ... }
// subtasks = [{ id, description, strategy, target, prompt }, ...]

const orchestrator = new Orchestrator({ spawnFn: cliSpawnFn });
const results = await orchestrator.spawnParallelSessions(subtasks, process.cwd());
const output = aggregateResults(results);
console.log(output);
```

## License

MIT
