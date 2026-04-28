# js-breakdown

Break complex tasks into parallel subtasks executed by Claude Code agents. This skill analyzes a user's natural-language task, classifies it into a decomposition strategy, splits it into N independently executable subtasks, spawns parallel agent sessions, monitors them, and aggregates results into a unified report.

**Works with English, Chinese, Japanese, and Korean (CJK) task descriptions** — the decomposition engine includes CJK-aware pattern matching, enumeration detection (`、`, `：`), and strategy detection tuned for non-English phrasing.

---

## When to Use This Skill

Invoke this skill when the user's task meets **any** of these criteria:

- **Explicit parallelization request** — User asks to "split this into parallel tasks", "decompose this", "break this down", "run this in parallel", or uses `/breakdown`
- **Multi-item task** — Task lists multiple files, modules, features, or perspectives (e.g., "Add dark mode to settings, dashboard, and profile")
- **Cross-cutting analysis** — Task asks to review/audit/analyze from multiple angles (security, performance, accessibility, etc.)
- **Directory-scoped work** — Task targets "all files in", "every module in", "each component in"
- **Pipeline/stage-based work** — Task describes sequential stages that could be partially parallelized
- **High-complexity task** — Large, ambiguous, or multi-day task that benefits from decomposition
- **CJK task descriptions** — Tasks in Chinese, Japanese, or Korean that describe multi-feature work or multi-perspective analysis

**Do NOT invoke this skill when:**
- The task is a single, atomic operation (e.g., "rename getCwd to getCurrentWorkingDirectory")
- The task is a simple question or explanation request
- The user explicitly asks for sequential, non-parallel execution
- The task requires tight coupling between steps where agents must share intermediate results in real time

---

## Workflow

### Step 1: Extract the Task

Extract the user's task description from the message. The task may be:

- A quoted string: `"Review all TypeScript files in src/ for security issues"`
- A `/breakdown` slash command argument
- The user's entire message (if the message is a single task description)
- Piped from stdin (in CLI mode)

If the user provided no task description, respond: "What task would you like me to break down?"

### Step 2: Run the Decomposer

Run the decomposition CLI in dry-run JSON mode to get the analysis and subtask plans without spawning agents:

```bash
node cli/breakdown.js --task "<TASK_DESCRIPTION>" --json --dry-run
```

If `cli/breakdown.js` is not found in the current working directory, resolve it relative to the skill installation path:

```bash
node $SKILL_DIR/cli/breakdown.js --task "<TASK_DESCRIPTION>" --json --dry-run
```

**Required:** Escape double quotes in the task description with `\"` or use single quotes if the shell supports it.

#### Respect User Overrides

If the user specified `--max-agents` (or `-n`), pass it through:

```bash
node cli/breakdown.js --task "<TASK>" --json --dry-run --max-agents <N>
```

#### Parse the JSON Output

The command outputs a JSON object with this structure:

```json
{
  "analysis": {
    "taskType": "by-feature",
    "suggestedN": 4,
    "complexity": 6,
    "explicitItems": ["settings", "dashboard", "profile", "notifications"]
  },
  "subtasks": [
    {
      "id": "subtask-1",
      "description": "settings",
      "strategy": "by-feature",
      "target": "settings",
      "prompt": "Add dark mode support to all components...\n\n---\nYour assigned feature: settings..."
    },
    ...
  ]
}
```

#### Handle the "Too Simple" Case

If `analysis.suggestedN < 2` or `analysis.complexity < 3`:

1. Tell the user: "This task is straightforward enough that parallel decomposition wouldn't help. I'll handle it directly."
2. Execute the task yourself as a single agent. Do NOT spawn parallel sessions.
3. Skip to Step 6 (present results).

### Step 3: Present the Decomposition Plan

Before spawning agents, show the user the plan:

```
I've analyzed the task and here's the decomposition plan:

  Strategy:    by-feature
  Complexity:  6/10
  Parallel agents: 4
  Max concurrent:  8

Subtasks:
  1. [subtask-1] settings           (by-feature)
  2. [subtask-2] dashboard          (by-feature)
  3. [subtask-3] profile            (by-feature)
  4. [subtask-4] notifications      (by-feature)

Proceeding with parallel execution...
```

If the user specified `--dry-run`, stop here — do not spawn agents. The user only wanted the plan.

### Step 4: Spawn Parallel Agent Sessions

For each subtask in the JSON `subtasks` array, spawn an agent session. Use `sessions_spawn` with these parameters:

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

**Concurrency control:** Spawn all subtasks simultaneously but respect the `maxConcurrentSessions` cap (default 8). If there are more subtasks than the cap, spawn in batches:

1. Spawn the first `maxConcurrentSessions` agents
2. As each agent completes, spawn the next queued subtask
3. Continue until all subtasks have been spawned and completed

**Pipeline tasks (by-pipeline):** For pipeline-strategy tasks, subtasks have an `order` field. Spawn stages that have no dependency simultaneously, but respect sequential constraints. Typically, all pipeline stages are spawned in order but each stage must complete before the next begins — unless stages are explicitly marked as parallelizable.

### Step 5: Monitor Agent Progress

Track session statuses. Use `sessions_status` or equivalent to poll agent states periodically (every 5–10 seconds for long-running tasks, or rely on `sessions_spawn` completion notifications if the runtime supports them).

For each agent, track:
- **Started** — session has been spawned and is running
- **Completed** — session returned a result (store the output)
- **Failed** — session errored (handle retry or record failure)

#### Retry Logic

When a subtask fails:
1. Retry up to `retryCount` times (default 2)
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

#### Choose Aggregation Strategy

Based on `analysis.taskType` from Step 2:

| Strategy | Task Type | Method | Description |
|----------|-----------|--------|-------------|
| `concatenate` | `by-directory`, `by-feature` | Section concatenation | Each agent's output becomes a markdown section with the subtask description as header |
| `merge-dedup` | `by-perspective` | Finding deduplication | Parse findings from all agents, deduplicate by content hash, group by severity (Critical → High → Medium → Low → Info) |
| `summary` | `by-pipeline` | Stage-by-stage summary | Present results in pipeline order with stage status (COMPLETED/FAILED) and duration |

#### Aggregation Format

Produce a single markdown document:

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

────────────────────────────────────────────────────────────

## profile (profile/)
> FAILED: claude exited with code 1

────────────────────────────────────────────────────────────

### Failed Subtasks
- **profile**: claude exited with code 1 (after 2 retries)
```

For **by-perspective** tasks, use the deduplication format:

```
# Aggregated Findings (28 total, deduplicated)

## Critical (3)
1. **Finding title** — Description
   - Source perspective: security, architecture

## High (8)
...

## Medium (12)
...

## Low (5)
...
```

### Step 7: Present the Final Report

Output the aggregated markdown to the user. Include:

1. **Summary line** — strategy, success/failure count, total duration
2. **Per-subtask sections** — each agent's output with duration
3. **Failed subtask summary** (if any) — which subtasks failed and why
4. **Work directory note** — mention that raw outputs are preserved in `.js-breakdown/`

### Step 8: Clean Up (Optional)

By default, preserve work directories under `.js-breakdown/` for inspection. If the user requests cleanup, or if the `JSBD_CLEANUP` env var is set to `1`, remove the `.js-breakdown/` directory after presenting the report.

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
/skill:breakdown --max-agents 6 "Review all files in src/ for bugs"
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

## Error Handling

### Decomposer CLI Fails to Run

If `node cli/breakdown.js` fails (Node.js not installed, file not found, etc.):

1. Try resolving the path with `$SKILL_DIR` prefix
2. If that also fails, fall back to manual decomposition:
   - Manually analyze the task using the strategy detection rules (see `src/breakdown.js` STRATEGY_PATTERNS)
   - Split the task into 2–4 subtasks based on your best judgment
   - Assign each subtask a clear, self-contained prompt
   - Proceed with Steps 4–8
3. Warn the user: "The breakdown CLI wasn't available (${error}). I've decomposed the task manually — the split may not be optimal."

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

If the decomposer returns `suggestedN < 2` or the user's task is inherently sequential:

1. Tell the user: "This task can't be meaningfully parallelized because [reason]. I'll execute it directly."
2. Execute the entire task yourself as a single agent
3. Return results normally

Common reasons a task can't be decomposed:
- Single, atomic action (e.g., "rename this variable")
- Tightly coupled steps where each depends on the previous output
- The task scope is too narrow to benefit from parallelism

---

## Examples

### Example 1: Feature Development (English)

**User input:**
```
/skill:breakdown "Add dark mode support to the settings panel, user dashboard, and profile page"
```

**Step-by-step behavior:**

1. **Extract task**: `"Add dark mode support to the settings panel, user dashboard, and profile page"`
2. **Run decomposer**:
   ```
   node cli/breakdown.js --task "Add dark mode support to the settings panel, user dashboard, and profile page" --json --dry-run
   ```
3. **JSON output**:
   ```json
   {
     "analysis": {
       "taskType": "by-feature",
       "suggestedN": 3,
       "complexity": 5,
       "explicitItems": ["settings panel", "user dashboard", "profile page"]
     },
     "subtasks": [
       {
         "id": "subtask-1",
         "description": "settings panel",
         "strategy": "by-feature",
         "target": "settings panel",
         "prompt": "Add dark mode support to the settings panel, user dashboard, and profile page\n\n---\nYour assigned feature: settings panel\nFocus exclusively on this feature area."
       },
       {
         "id": "subtask-2",
         "description": "user dashboard",
         "strategy": "by-feature",
         "target": "user dashboard",
         "prompt": "Add dark mode support to the settings panel, user dashboard, and profile page\n\n---\nYour assigned feature: user dashboard\nFocus exclusively on this feature area."
       },
       {
         "id": "subtask-3",
         "description": "profile page",
         "strategy": "by-feature",
         "target": "profile page",
         "prompt": "Add dark mode support to the settings panel, user dashboard, and profile page\n\n---\nYour assigned feature: profile page\nFocus exclusively on this feature area."
       }
     ]
   }
   ```
4. **Present plan**: Show strategy=by-feature, 3 agents, complexity=5/10
5. **Spawn 3 agents**: Each gets a feature-specific prompt
6. **Monitor**: Track progress, report completions
7. **Aggregate**: Concatenation strategy — each agent's output as a section
8. **Present report**: Unified markdown with settings/dashboard/profile sections

### Example 2: Security Audit (Multi-Perspective)

**User input:**
```
/skill:breakdown --max-agents 4 "Audit the REST API for vulnerabilities"
```

**Step-by-step behavior:**

1. **Extract task**: `"Audit the REST API for vulnerabilities"` with max-agents=4
2. **Run decomposer** (with `--max-agents 4`):
   ```
   node cli/breakdown.js --task "Audit the REST API for vulnerabilities" --json --dry-run --max-agents 4
   ```
3. **JSON output**: `taskType: "by-perspective"`, `suggestedN: 4`, `complexity: 7`
4. **Subtask prompts**: Each agent gets the same task but a different perspective:
   - Agent 1: "Focus exclusively on the **security** perspective. Look for vulnerabilities, injection risks, broken auth, data exposure."
   - Agent 2: "Focus exclusively on the **performance** perspective. Identify bottlenecks, unnecessary allocations, slow queries."
   - Agent 3: "Focus exclusively on the **maintainability** perspective. Assess code clarity, coupling, duplication."
   - Agent 4: "Focus exclusively on the **reliability** perspective. Examine error handling, edge cases, race conditions."
5. **Spawn 4 agents** concurrently
6. **Aggregate**: Merge-dedup strategy — parse findings, deduplicate by hash, group by severity
7. **Present report**: Findings grouped as Critical/High/Medium/Low/Info, with source perspective tags

### Example 3: CJK Task (Chinese)

**User input:**
```
在 src/ 目录中实现用户认证、权限管理和审计日志功能
```
(Translation: "Implement user authentication, permission management, and audit logging in src/")

**Step-by-step behavior:**

1. **Extract task**: Chinese text describing 3 features
2. **Run decomposer**: The CJK pattern matchers detect:
   - `[实现]+.*[功能]+` matches the by-feature strategy
   - The `、` separator in a non-bullet context triggers Chinese enumeration detection
3. **JSON output**: `taskType: "by-feature"`, `suggestedN: 3`, `explicitItems: ["用户认证", "权限管理", "审计日志"]`
4. **Spawn 3 agents**: Each with a Chinese+English hybrid prompt scoped to their feature
5. **Aggregate**: Concatenation strategy
6. **Present report**: Three sections in markdown, one per feature

---

## Decomposition Strategies Reference

The skill auto-detects which strategy to use based on 140+ regex patterns covering English and CJK phrasing:

| Strategy | Best For | Example Triggers |
|----------|----------|-----------------|
| **by-directory** | File/directory-scoped work | "Review all files in src/", "Lint every module", "整理所有文件" |
| **by-feature** | Feature/module development | "Add dark mode to settings, dashboard", "实现用户认证、权限管理" |
| **by-perspective** | Multi-angle analysis/review | "Audit for security", "全面审查代码质量", "Review from multiple perspectives" |
| **by-pipeline** | Sequential stage-based work | "Migrate database and update models", "构建部署流水线", "ETL pipeline" |

---

## OpenClaw Integration Workflow (Programmatic API)

For programmatic use within OpenClaw skill handlers, the `src/openclaw-integration.js` and `src/acp-spawn.js` modules provide a structured 4-phase workflow that generates exact `sessions_spawn` calls and parses results.

### Architecture

```
src/
  breakdown.js               ← analyzeTask() + decompose() — task classification
  acp-spawn.js                ← generateSpawnInstructions() + createAcpSpawnFn()
  openclaw-integration.js     ← generateDecompositionPlan() + parseAgentResults()
  orchestrator.js             ← spawns + manages parallel sessions (CLI mode)
  aggregation.js              ← merges results by strategy
```

### Phase 1: Decompose the Task

Call `breakdown()` or `generateDecompositionPlan()` to analyze and split the task:

```js
import { breakdown } from './src/breakdown.js';

const { analysis, subtasks } = breakdown(
  'Review all TypeScript files in src/ for security vulnerabilities'
);

// analysis = { taskType: 'by-perspective', suggestedN: 4, complexity: 7, ... }
// subtasks = [{ id, description, strategy, target, prompt }, ...]
```

### Phase 2: Generate sessions_spawn Instructions

Use `generateDecompositionPlan()` to get the exact `sessions_spawn` calls:

```js
import { generateDecompositionPlan } from './src/openclaw-integration.js';

const plan = generateDecompositionPlan(
  'Review all TypeScript files in src/ for security vulnerabilities',
  { maxConcurrentSessions: 4, cwd: process.cwd() }
);

// plan.spawnInstructions[0].sessionsSpawnCall:
// {
//   tool: 'sessions_spawn',
//   description: 'Analyze from perspective: security',
//   prompt: 'Review all TypeScript files...\n\n---\nFocus exclusively on security...',
//   workDir: '/project/.js-breakdown/subtask-1',
//   id: 'subtask-1',
//   metadata: { strategy: 'by-perspective', target: 'security' }
// }

// plan.planMarkdown contains the full markdown spawn plan for the host agent
console.log(plan.planMarkdown);
```

The `createIntegrationPlan()` function also returns structured instructions for each phase:

```js
import { createIntegrationPlan } from './src/openclaw-integration.js';

const fullPlan = createIntegrationPlan('Audit the REST API for vulnerabilities');

// fullPlan.instructions.phase2.calls → array of exact sessions_spawn parameters
// fullPlan.instructions.phase4.code → code snippet for result parsing
```

### Phase 3: Execute sessions_spawn Calls

OpenClaw reads the spawn instructions and calls `sessions_spawn` for each subtask in parallel:

```
sessions_spawn(
  description: "Analyze from perspective: security",
  prompt: """Review all TypeScript files in src/ for security vulnerabilities

---
Focus exclusively on the security perspective. Look for vulnerabilities, injection risks, broken auth, data exposure.""",
  workDir: ".js-breakdown/subtask-1",
  id: "subtask-1",
  runtime: "acp",
  agentId: "claude",
  mode: "run",
  timeout: 600000
)
```

Spawn all subtasks simultaneously (respecting `maxConcurrentSessions` cap). Collect results as each session completes.

### Phase 4: Parse and Aggregate Results

Once all sessions complete, pass the collected results to `parseAgentResults()`:

```js
import { parseAgentResults } from './src/openclaw-integration.js';

const rawResults = [
  {
    id: 'subtask-1',
    description: 'Analyze from perspective: security',
    strategy: 'by-perspective',
    target: 'security',
    output: '## Critical: SQL injection in login...\n## High: Missing CSRF...',
    durationMs: 45000
  },
  {
    id: 'subtask-2',
    description: 'Analyze from perspective: performance',
    strategy: 'by-perspective',
    target: 'performance',
    output: '## Medium: N+1 query in dashboard...',
    durationMs: 32000
  },
  // ... more results
];

const { markdown, summary } = parseAgentResults(rawResults);

console.log(summary);
// { total: 4, succeeded: 3, failed: 1, results: [...] }

console.log(markdown);
// # Aggregated Findings (12 total, deduplicated)
// ## Critical (2)
// 1. **SQL injection in login** — ... Source perspective: security
// ## High (3)
// ...
```

### Low-Level ACP Spawn API

For fine-grained control, `src/acp-spawn.js` provides lower-level functions:

```js
import { acpSpawnFn, generateSpawnInstructions } from './src/acp-spawn.js';

// Option 1: Generate instructions for external consumption
const instructions = generateSpawnInstructions(subtasks, process.cwd());
for (const inst of instructions) {
  // inst.sessionsSpawnCall contains the exact parameters for sessions_spawn
  console.log(inst.sessionsSpawnCall);
}

// Option 2: Create a deferred session handle
const handle = await acpSpawnFn(subtask, '/tmp/work/subtask-1');
// handle.wait() → Promise that resolves when handle._resolve(result) is called
// The host (OpenClaw) reads handle.prompt, calls sessions_spawn,
// then calls handle._resolve(output) with the result.
```

### Integration with the Orchestrator

For advanced use cases where you want the Orchestrator's concurrency management and retry logic alongside ACP spawning:

```js
import { Orchestrator } from './src/orchestrator.js';
import { createAcpSpawnFn } from './src/acp-spawn.js';

const spawnFn = createAcpSpawnFn({
  onSpawn: (subtask, workDir, resolve, reject) => {
    // Called for each subtask. The host calls sessions_spawn here
    // and feeds the result back:
    //   const result = await sessionsSpawn({ ... });
    //   resolve(result.output);
    // Or on error:
    //   reject(new Error(result.error));
  },
});

const orch = new Orchestrator({ spawnFn, maxConcurrent: 4 });
const results = await orch.runAll(subtasks, process.cwd());
```

---

## Limitations and Caveats

1. **Independent subtasks only** — This skill decomposes into *independent* subtasks. If subtasks have hard runtime dependencies on each other's outputs, decomposition will produce incorrect results. Use sequential execution instead.

2. **File-based coordination only** — Agents coordinate through the shared filesystem (`.js-breakdown/`). There is no real-time inter-agent messaging. If agents need to negotiate or synchronize during execution, this skill is not appropriate.

3. **Overhead for small tasks** — For tasks completable in under 30 seconds by a single agent, the decomposition and aggregation overhead may exceed the parallelization benefit. The skill will decline to decompose tasks with complexity < 3.

4. **Not for real-time collaboration** — Each agent works in isolation on its assigned scope. If the task requires agents to jointly design an API contract or negotiate architecture decisions in real time, handle it with a single multi-turn session instead.

5. **Output quality depends on prompt clarity** — The quality of subtask outputs depends on how well the original task description scopes each subtask. Vague tasks produce vague subtask prompts. Encourage users to be specific.

6. **CJK coverage is not exhaustive** — CJK pattern matching covers common Chinese software development terminology (实现、重构、修复、优化、审查、测试) and enumeration patterns (、, ：). Uncommon phrasing or domain-specific jargon may not be detected correctly. In such cases, specify the strategy explicitly or list subtasks manually.

7. **Token consumption** — Parallel agents consume tokens independently. A 4-agent decomposition uses roughly 4x the tokens of a single-agent run. Consider this cost before decomposing borderline tasks.

---

## Notes

- Subtask work directories are created under `.js-breakdown/<subtask-id>/` within the project root
- Each agent's prompt is also written to `.js-breakdown/<subtask-id>/task.md` for debugging
- The aggregation module's finding deduplication uses content hashing — near-duplicate findings (same issue, different wording) may not be deduplicated
- Environment variables override defaults; CLI flags (`--max-agents`) override environment variables
- For programmatic use, see `src/openclaw-integration.js` (high-level API) and `src/acp-spawn.js` (low-level ACP spawn integration)
