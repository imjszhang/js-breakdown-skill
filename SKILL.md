# js-breakdown

Break complex tasks into parallel subtasks executed by Claude Code agents via ACP (Agent Communication Protocol).

## Description

This skill takes any user task description and intelligently decomposes it into N independently executable subtasks. Each subtask runs in its own Claude Code session via ACP, coordinated through the shared filesystem. Results are automatically aggregated into a unified output.

Key capabilities:
- **Dynamic parallelism** — The decomposer determines optimal N based on task complexity, not a fixed constant
- **File-based coordination** — Agents coordinate through a shared workspace directory, avoiding direct inter-agent communication complexity
- **Multiple decomposition strategies** — Different task types are broken down using appropriate patterns (by file, by feature, by perspective, by pipeline stage)
- **Fault tolerance** — Individual subtask failures don't block the overall pipeline; partial results are preserved

## Usage

### From OpenClaw

Invoke this skill when a user asks to parallelize a task:

```
/skill:breakdown "Review all TypeScript files in src/ for security vulnerabilities"
```

Or more explicitly:

```
/skill:breakdown --task "Write unit tests for every module in lib/" --max-agents 8
```

### From CLI

```bash
echo "Add dark mode support to the settings panel, dashboard, and profile page" | npx js-breakdown
```

```bash
npx js-breakdown "Refactor the authentication module: split into smaller files, add types, write tests"
```

## Decomposition Workflow

1. **Analyze** — Classify the task type (by-directory, by-feature, by-perspective, by-pipeline) and estimate complexity
2. **Determine N** — Calculate optimal parallelism from task granularity, maxConcurrentSessions config, and diminishing-returns threshold
3. **Decompose** — Generate N subtask plans, each self-contained with clear input/output boundaries
4. **Orchestrate** — Spawn N parallel ACP sessions with filesystem-isolated working directories
5. **Aggregate** — Merge results using strategy appropriate to the task type (concatenation, merge-dedup, or summary extraction)

## Configuration

Configuration is read from the OpenClaw config or environment variables:

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `maxConcurrentSessions` | `JSBD_MAX_CONCURRENT` | 8 | Hard cap on parallel agents |
| `defaultParallelism` | `JSBD_DEFAULT_PARALLEL` | 4 | Default N when complexity is ambiguous |
| `minParallelism` | `JSBD_MIN_PARALLEL` | 2 | Minimum subtasks for any decomposition |
| `retryCount` | `JSBD_RETRY_COUNT` | 2 | Max retries per failed subtask |
| `workDir` | `JSBD_WORK_DIR` | `.js-breakdown` | Shared filesystem workspace |

## Task Types & Strategies

### by-directory
Partition work by filesystem paths. Used for code review, linting, documentation.
*Example*: "Review all modules in src/" → one agent per top-level directory.

### by-feature
Partition work by functional module. Used for feature development, bug fixes.
*Example*: "Add dark mode to settings, dashboard, profile" → one agent per feature area.

### by-perspective
Same artifact reviewed from multiple angles. Used for security review, research.
*Example*: "Audit the API for vulnerabilities" → agents focus on auth, injection, data exposure, logic.

### by-pipeline
Linear stages that can be partially parallelized. Used for data processing, build pipelines.
*Example*: "Migrate database and update models" → stages: schema export, migration script, model update, test.

## Example: Code Review

```
Input:  "Review all TypeScript files in src/ for security issues"
Output:
  Agent 1 (src/api/):     Found 2 SQL injection risks, 1 missing auth check
  Agent 2 (src/components/): Found 3 XSS vulnerabilities
  Agent 3 (src/utils/):   Found 1 prototype pollution
  Agent 4 (src/hooks/):   No issues found

Aggregated report with 6 total findings across 4 modules.
```

## Notes

- Subtasks should be truly independent — avoid decompositions where agents need each other's output
- The shared workspace is cleaned up after successful aggregation
- Failed subtasks are retried up to `retryCount` times before the result is marked incomplete
- Large outputs are truncated in the aggregate view; raw files remain in the work directory
