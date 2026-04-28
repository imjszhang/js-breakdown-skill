# Example: Code Review

## Scenario

You have a TypeScript monorepo and want to review every module for security vulnerabilities, code quality issues, and potential bugs.

## Task Description

```
Review all TypeScript files in the src/ directory for:
- Security vulnerabilities (injection, XSS, auth bypass)
- Error handling gaps (uncaught promises, missing try/catch)
- Performance anti-patterns (N+1 queries, unnecessary allocations)
- TypeScript strict-mode violations
```

## What Happens

### Step 1: Analysis

```
Task type:    by-directory
Complexity:   7/10
Suggested N:  5

Detection logic:
  - Matches "all TypeScript files in" → by-directory strategy
  - Cross-cutting concerns (security, perf, types) → higher complexity
  - Deprecated items: src/api, src/components, src/utils, src/hooks, src/lib
```

### Step 2: Decomposition

Each agent gets one directory:

| Agent | Scope | Focus |
|-------|-------|-------|
| 1 | `src/api/` | Security, error handling, perf, types |
| 2 | `src/components/` | Security, error handling, perf, types |
| 3 | `src/utils/` | Security, error handling, perf, types |
| 4 | `src/hooks/` | Security, error handling, perf, types |
| 5 | `src/lib/` | Security, error handling, perf, types |

### Step 3: Execution

All 5 agents run concurrently. Each:

1. Lists files in their assigned directory
2. Reads each file
3. Analyzes for the four concern categories
4. Produces findings as structured markdown

### Step 4: Aggregation (concatenation strategy)

```markdown
## Review of src/api/ (src/api/)
> Duration: 45.2s

### Security
- **HIGH**: SQL injection risk in `users.ts:42` — string interpolation in query
- **MEDIUM**: Missing auth middleware on `/admin/export` in `routes.ts:128`

### Error Handling
- **LOW**: Uncaught promise in `payment.ts:89`

### Performance
No issues found.

### TypeScript
- **INFO**: 12 `any` type usages across 4 files

──────────────────────────────────────────────────────────

## Review of src/components/ (src/components/)
> Duration: 38.7s

### Security
- **HIGH**: XSS vulnerability in `CommentList.tsx:56` — raw HTML injection
...
```

## CLI Command

```bash
npx js-breakdown "Review all TypeScript files in src/ for security vulnerabilities, error handling gaps, performance anti-patterns, and TypeScript strict-mode violations"
```

## Expected Output

A single markdown document with per-directory sections and a final summary counting findings by severity across all directories.
