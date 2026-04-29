# js-breakdown

Break complex tasks into parallel subtasks executed by Claude Code agents. This skill is a **pure parallel task scheduler** — the OpenClaw Agent (with LLM semantic understanding) makes all decomposition decisions, and js-breakdown handles execution, concurrency control, and result aggregation.

**Works with English, Chinese, Japanese, and Korean (CJK) task descriptions** — the Agent understands the task in any language, reads project structure, and writes precise subtask prompts.

---

## Architecture Philosophy

```
┌──────────────────────────────────────────────────┐
│  OpenClaw Agent (LLM)                             │
│  - Understands task semantics                     │
│  - Reads project file structure                   │
│  - Decides: strategy, N, file assignments         │
│  - Writes precise, context-aware subtask prompts   │
└──────────┬───────────────────────────────────────┘
           │ submits decomposition plan
           ▼
┌──────────────────────────────────────────────────┐
│  js-breakdown skill (scheduler)                   │
│  - Spawns parallel agent sessions                 │
│  - Manages concurrency & retries                  │
│  - Aggregates results by strategy                 │
└──────────────────────────────────────────────────┘
```

**Key insight:** The skill used to do regex-based strategy detection (140+ patterns) and generate generic subtask prompts. This was inaccurate and didn't use project context. Now the Agent does all the thinking — the skill is purely a scheduler.

---

## When to Use This Skill

Invoke this skill when the user's task meets **any** of these criteria:

- **Explicit parallelization request** — User asks to "split this into parallel tasks", "decompose this", "break this down", "run this in parallel", or uses `/breakdown`
- **Multi-item task** — Task lists multiple files, modules, features, or perspectives (e.g., "Add dark mode to settings, dashboard, and profile")
- **Cross-cutting analysis** — Task asks to review/audit/analyze from multiple angles (security, performance, accessibility, etc.)
- **Directory-scoped work** — Task targets "all files in", "every module in", "each component in"
- **Pipeline/stage-based work** — Task describes sequential stages that could be partially parallelized
- **High-complexity task** — Large, ambiguous, or multi-day task that benefits from decomposition

**Do NOT invoke this skill when:**
- The task is a single, atomic operation (e.g., "rename getCwd to getCurrentWorkingDirectory")
- The task is a simple question or explanation request
- The user explicitly asks for sequential, non-parallel execution
- The task requires tight coupling between steps where agents must share intermediate results in real time

---

## Workflow

### Step 1: Agent Analyzes the Task (NEW — replaces legacy CLI dry-run)

**The OpenClaw Agent does the decomposition, not the skill code.**

The Agent should:

1. **Understand the task** — Parse the user's task description (any language). Identify what needs to be done, what the scope is, and whether it can benefit from parallelization.

2. **Read project structure** — Use `tree` or equivalent to understand the file layout:
   ```
   # Quick: list top-level structure
   ls -R --max-depth=2
   # Or: use tree if available
   tree -L 2 -I 'node_modules|.git'
   ```

3. **Read key files** — If the task mentions specific files or directories, read them to understand scope and inter-dependencies. For cross-cutting tasks, read representative files to gauge complexity.

4. **Decide decomposition strategy** — Choose one of four strategies based on the task shape:

   | Strategy | Best For | Decision Criteria |
   |----------|----------|-------------------|
   | `by-feature` | Feature/module work with clear boundaries | Task lists distinct features, modules, or components that can be worked on independently |
   | `by-directory` | File/directory-scoped work | Task targets specific directories with disjoint scopes; each subtask works on its own directory |
   | `by-perspective` | Multi-angle analysis/review | Task asks to review from multiple quality dimensions (security, performance, maintainability, etc.) |
   | `by-pipeline` | Sequential stage-based work | Task has clear sequential stages; each stage must complete before the next can start |

5. **Determine subtask count (N)** — Based on:
   - Number of explicit items in the task (files, features, perspectives, stages)
   - Task complexity (scope breadth, technical depth, cross-cutting concerns)
   - Practical limits: 2 ≤ N ≤ 8 (fewer is better — only split when there's clear parallelism)

6. **Assign files to subtasks** — For each subtask, specify which files/directories it should work on. This is critical for avoiding conflicts and ensuring complete coverage.

7. **Write precise subtask prompts** — Each prompt must include:
   - The original task context
   - Specific files/directories the subtask is responsible for
   - Clear scope boundaries ("only modify X, do not touch Y")
   - Concrete acceptance criteria
   - Any cross-cutting concerns to note but not implement

8. **Determine dependencies** — For `by-pipeline` tasks, specify the order (stage 0 → stage 1 → stage 2). For all other strategies, subtasks should be fully independent.

**If the task is too simple to decompose** (complexity < 3, single file/action):
1. Tell the user: "This task is straightforward enough that parallel decomposition wouldn't help. I'll handle it directly."
2. Execute the task yourself. Skip Steps 2-7.

### Step 2: Present the Decomposition Plan

Show the user the plan for confirmation:

```
## Decomposition Plan

**Strategy:** by-feature
**Subtasks:** 3
**Max concurrent:** 8

### Subtask 1: settings
- **Strategy:** by-feature
- **Files:** src/components/settings/, src/styles/settings.css
- **Prompt summary:** Add dark mode to the settings panel. Only modify files under
  src/components/settings/ and src/styles/settings.css. Add CSS variables for color
  scheme, toggle component, and persist preference to localStorage.
- **Dependencies:** none

### Subtask 2: dashboard
- **Strategy:** by-feature
- **Files:** src/components/dashboard/, src/styles/dashboard.css
- **Prompt summary:** Add dark mode to the user dashboard. Only modify files under
  src/components/dashboard/ and src/styles/dashboard.css. Use the same CSS variable
  names as the settings subtask for consistency.
- **Dependencies:** none (but coordinate CSS variable names with subtask 1)

### Subtask 3: profile
- **Strategy:** by-feature
- **Files:** src/components/profile/, src/styles/profile.css
- **Prompt summary:** Add dark mode to the profile page. Only modify files under
  src/components/profile/ and src/styles/profile.css. Use the same CSS variable
  naming convention.
- **Dependencies:** none
```

If the user specified `--dry-run`, **stop here** — do not spawn agents.

### Step 3: Write Subtask Prompts to Work Directory

For each subtask, create its work directory and write the prompt:

```bash
mkdir -p .js-breakdown/<subtask-id>
```

Write the full prompt to `.js-breakdown/<subtask-id>/task.md`. This file serves as both the agent's instructions and a debugging record.

### Step 4: Spawn Parallel Agent Sessions

For each subtask, spawn an agent session via `sessions_spawn`:

```
sessions_spawn(
  runtime: "acp",
  agentId: "claude",
  prompt: <subtask.prompt>,
  mode: "run",
  timeout: 600000,        // 10 minutes per subtask
  workDir: ".js-breakdown/<subtask.id>"
)
```

**Concurrency control:** Respect `maxConcurrentSessions` (default 8). If there are more subtasks than the cap:

1. Spawn the first N agents (up to the cap)
2. As each agent completes, spawn the next queued subtask
3. Continue until all subtasks have been spawned and completed

**Pipeline tasks (by-pipeline):** For pipeline-strategy tasks, spawn stages in order. Each stage must complete before the next begins — unless stages are explicitly marked as parallelizable.

### Step 5: Monitor Agent Progress

Track session statuses:

- **Started** — session has been spawned and is running
- **Completed** — session returned a result (store the output)
- **Failed** — session errored (handle retry or record failure)

#### Retry Logic

When a subtask fails:
1. Retry up to `JSBD_RETRY_COUNT` times (default 2)
2. On retry, re-spawn with the same prompt and workDir
3. If all retries are exhausted, record the subtask as `FAILED` with the error message
4. Do NOT abort other running subtasks — they continue independently

#### Progress Reporting

Periodically report progress to the user:

```
  [subtask-1] Running: settings...
  [subtask-2] Done (45.2s)
  [subtask-3] Running: profile...
  [subtask-4] FAILED: claude exited with code 1 (retrying 1/2)
```

### Step 6: Aggregate Results

Once all agents complete (or fail permanently), aggregate the outputs.

#### Aggregation Strategies

| Task Strategy | Aggregation Method | Description |
|---------------|-------------------|-------------|
| `by-directory` | Concatenate | Each agent's output becomes a markdown section with the subtask description as header |
| `by-feature` | Concatenate | Each agent's output becomes a markdown section |
| `by-perspective` | Merge + Dedup | Parse findings from all agents, deduplicate by content hash, group by severity (Critical → High → Medium → Low → Info) |
| `by-pipeline` | Stage summary | Present results in pipeline order with stage status (COMPLETED/FAILED) and duration |

Use the aggregation module for consistent formatting:

```js
import { aggregateResults } from './src/aggregation.js';

const results = [ /* collected from sessions_spawn */ ];
const output = aggregateResults(results);
```

#### Aggregation Format

For `by-feature` / `by-directory`:

```
# Aggregated Results

> Strategy: by-feature | 3 of 4 subtasks succeeded | Total time: 2m 15s

────────────────────────────────────────────────────────────

## settings (settings/)
> Duration: 45.2s

[Agent output for settings...]

────────────────────────────────────────────────────────────

## dashboard (dashboard/)
> Duration: 38.7s

[Agent output for dashboard...]
```

For `by-perspective`:

```
# Aggregated Findings (28 total, deduplicated)

## Critical (3)
1. **SQL injection in login** — User input not parameterized
   - Source perspective: security, architecture

## High (8)
...

## Medium (12)
...
```

### Step 7: Present the Final Report

Output the aggregated markdown to the user. Include:

1. **Summary line** — strategy, success/failure count, total duration
2. **Per-subtask sections** — each agent's output with duration
3. **Failed subtask summary** (if any) — which subtasks failed and why
4. **Work directory note** — mention that raw outputs are preserved in `.js-breakdown/`

### Step 8: Archive Results (Required)

**Every task execution must produce an archived result folder.** This ensures traceability and future reference.

Create a result folder under the project's `.js-breakdown/results/` directory:

```
<project-root>/.js-breakdown/results/<YYYY-MM-DD-<task-slug>/
├── REPORT.md          # Full aggregated report (required)
├── DIFF.patch         # git diff snapshot of all changes (optional, for code tasks)
└── METADATA.txt       # Commit hash, agent list, duration (optional)
```

**REPORT.md 必须包含**:
- 任务背景和执行方式（strategy、agent 数量、耗时）
- 改动汇总（按文件列出改动 + 理由）
- 各 Agent 详细输出（每个 agent 的改动、发现、遗留建议）
- 执行反思（成功之处 + 不足 + 改进措施）
- 后续建议（优先级 + 预估工作量）

**命名规范**:
- 目录名: `YYYY-MM-DD-<简短英文描述>`（如 `2026-04-29-knowledge-collector-optimization`）
- 任务 slug 从用户原始任务描述中提取关键词

**完成后 commit 结果归档**（如果是代码项目）:
```bash
git add .js-breakdown/results/
git commit -m "docs: add js-breakdown result archive for <task-slug>"
```

### Step 9: Clean Up (Optional)

By default, preserve work directories under `.js-breakdown/` for inspection. If the user requests cleanup, or if the `JSBD_CLEANUP` env var is set to `1`, remove the `.js-breakdown/<subtask-id>/` work directories (but **never** remove `.js-breakdown/results/`).

---

## Configuration

All configuration is read from environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `JSBD_MAX_CONCURRENT` | `8` | Hard cap on simultaneously running agents |
| `JSBD_DEFAULT_PARALLEL` | `4` | Default N when complexity is ambiguous |
| `JSBD_MIN_PARALLEL` | `2` | Minimum subtasks for any decomposition |
| `JSBD_RETRY_COUNT` | `2` | Max retries per failed subtask |
| `JSBD_WORK_DIR` | `.js-breakdown` | Shared filesystem workspace directory |
| `JSBD_CLEANUP` | `0` | Set to `1` to auto-delete work directory after completion |

To override at invocation time:

```
/breakdown --max-agents 6 "Review all files in src/ for bugs"
```

Or in the OpenClaw configuration:

```yaml
skills:
  js-breakdown:
    env:
      JSBD_MAX_CONCURRENT: 6
      JSBD_RETRY_COUNT: 1
      JSBD_CLEANUP: 1
```

---

## Execution via Programmatic API (Optional)

When the Agent has produced a decomposition plan, it can use the programmatic API to handle execution with proper concurrency control and retry logic:

```js
import { Orchestrator } from './src/orchestrator.js';
import { aggregateResults } from './src/aggregation.js';

// The Agent's decomposition plan (already decided in Step 1)
const subtasks = [
  {
    id: 'subtask-1',
    description: 'Add dark mode to settings panel',
    strategy: 'by-feature',
    target: 'settings',
    prompt: 'Add dark mode support to src/components/settings/...\n\nOnly modify files under src/components/settings/ and src/styles/settings.css.\n\nAcceptance criteria:\n- Dark mode toggle in settings\n- Persist preference to localStorage\n- Use CSS custom properties for colors',
    files: ['src/components/settings/', 'src/styles/settings.css'],
  },
  // ... more subtasks
];

// Spawn and monitor
const orchestrator = new Orchestrator({
  spawnFn: cliSpawnFn,      // or ACP spawn function
  maxConcurrent: 8,
  retryCount: 2,
  workDir: '.js-breakdown',
});

const results = await orchestrator.runAll(subtasks, process.cwd());

// Aggregate
const markdown = aggregateResults(results);
console.log(markdown);
```

Alternatively, generate sessions_spawn instructions for manual execution:

```js
import { generateSpawnInstructions, formatSpawnInstructions } from './src/acp-spawn.js';

const instructions = generateSpawnInstructions(subtasks, process.cwd());
console.log(formatSpawnInstructions(instructions));
// → OpenClaw reads this and calls sessions_spawn for each subtask
```

---

## Legacy Mode (--legacy)

For environments where the Agent cannot do semantic analysis (pure CLI, no LLM available), the skill preserves its original regex-based decomposition as a fallback:

```bash
node cli/breakdown.js --legacy "Add dark mode to settings, dashboard, and profile"
```

In legacy mode, `src/breakdown.js` uses regex pattern matching to classify the task and generate subtask prompts. The prompts are generic (no project context) and the decomposition is based on keyword matching rather than semantic understanding. This mode exists only for backward compatibility — the agent-driven mode is always preferred.

---

## Decomposition Strategies Reference

The Agent should choose from these four strategies:

| Strategy | Best For | How to Split |
|----------|----------|-------------|
| **by-directory** | File/directory-scoped work | Assign each subtask a specific directory. Read the directory listing to ensure balanced workloads. |
| **by-feature** | Feature/module development | Assign each subtask a specific feature or module. Identify feature boundaries from project structure. |
| **by-perspective** | Multi-angle analysis/review | Assign each subtask a specific quality perspective (security, performance, maintainability, accessibility, reliability, testing, architecture, UX). All subtasks review the same code but from different angles. |
| **by-pipeline** | Sequential stage-based work | Split the pipeline into stages. Each stage is a subtask that consumes the output of the previous stage. |

---

## Error Handling

### Subtask Fails After All Retries

1. Record the failure in the aggregated report under "Failed Subtasks"
2. Include the error message and retry count
3. Do NOT block the overall report — present partial results
4. If ALL subtasks fail: tell the user "All N subtasks failed. The task may have an issue that prevents parallel execution. I'll handle it sequentially instead." Then execute the task yourself.

### Too Many Concurrent Sessions

If `sessions_spawn` fails with a concurrency-limit error:
1. Reduce `maxConcurrentSessions` by half
2. Retry the spawns with the reduced concurrency
3. Report the adjustment to the user

### Task Cannot Be Meaningfully Decomposed

If the Agent determines the task is inherently sequential or too small:

1. Tell the user: "This task can't be meaningfully parallelized because [reason]. I'll execute it directly."
2. Execute the entire task yourself as a single agent
3. Return results normally

Common reasons a task can't be decomposed:
- Single, atomic action (e.g., "rename this variable")
- Tightly coupled steps where each depends on the previous output
- The task scope is too narrow to benefit from parallelism

---

## Limitations and Caveats

1. **Independent subtasks only** — Subtasks must be independent. If subtasks have hard runtime dependencies on each other's outputs, use `by-pipeline` strategy or sequential execution.

2. **File-based coordination only** — Agents coordinate through the shared filesystem (`.js-breakdown/`). There is no real-time inter-agent messaging.

3. **Overhead for small tasks** — For tasks completable in under 30 seconds by a single agent, the decomposition and aggregation overhead may exceed the parallelization benefit.

4. **Not for real-time collaboration** — Each agent works in isolation. If agents need to jointly design an API contract or negotiate architecture decisions in real time, handle it with a single multi-turn session instead.

5. **Output quality depends on prompt quality** — The quality of subtask outputs depends on how well the Agent writes the subtask prompts. Be specific about file paths, scope boundaries, and acceptance criteria.

6. **Token consumption** — Parallel agents consume tokens independently. A 4-agent decomposition uses roughly 4x the tokens of a single-agent run.

---

## Notes

- Subtask work directories are created under `.js-breakdown/<subtask-id>/` within the project root
- Each agent's prompt is also written to `.js-breakdown/<subtask-id>/task.md` for debugging
- The aggregation module's finding deduplication uses content hashing — near-duplicate findings (same issue, different wording) may not be deduplicated
- Environment variables override defaults; CLI flags (`--max-agents`) override environment variables
- The legacy regex mode (`--legacy`) is available for pure CLI environments without LLM access
