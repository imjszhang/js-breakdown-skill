# Example: Research / Multi-Perspective Analysis

## Scenario

Before migrating from a monolithic architecture to microservices, the team needs a comprehensive analysis of the current system from multiple angles.

## Task Description

```
Analyze the current monolithic architecture and assess the feasibility of migrating to microservices.
Consider security implications, performance impact, data consistency challenges,
operational complexity, and developer experience.
```

## What Happens

### Step 1: Analysis

```
Task type:    by-perspective
Complexity:   9/10
Suggested N:  6

Detection logic:
  - "analyze" + "assess" → by-perspective strategy
  - Multiple explicit perspectives listed → high granularity
  - "architecture", "migrate", "security", "performance" → very high complexity
```

### Step 2: Decomposition

Each agent analyzes the same system but from a different perspective:

| Agent | Perspective | Guidance |
|-------|-------------|----------|
| 1 | Security | Auth boundaries, secrets management, inter-service auth, attack surface changes |
| 2 | Performance | Network overhead, serialization costs, caching strategy, cold start latency |
| 3 | Data Consistency | Distributed transactions, eventual consistency, saga patterns, migration strategy |
| 4 | Operational Complexity | Deployment pipeline changes, observability, service discovery, configuration management |
| 5 | Developer Experience | Local development setup, testing strategies, onboarding time, build times |
| 6 | Architecture | Service boundaries, dependency direction, shared kernel, API versioning |

### Step 3: Execution

All 6 agents run concurrently. Each gets the same codebase but analyzes through their specific lens:

```
Agent 1 (Security):          Scans auth code, network configs, secrets management → findings
Agent 2 (Performance):        Profiles hotspots, traces cross-service calls → findings
Agent 3 (Data Consistency):   Maps transactional boundaries, identifies shared state → findings
Agent 4 (Operational):        Reviews deploy scripts, CI/CD, infra-as-code → findings
Agent 5 (Developer Exp):      Assesses monorepo setup, test suites, local dev flow → findings
Agent 6 (Architecture):       Evaluates coupling, cohesion, domain boundaries → findings
```

### Step 4: Aggregation (merge-dedup strategy)

Because multiple agents may identify the same issue (e.g., tight coupling affects security AND performance AND architecture), findings are deduplicated:

1. Each agent's output is parsed into structured findings with severity levels
2. Findings are hashed and deduplicated across all agents
3. Related findings are grouped by severity

```markdown
# Aggregated Findings (28 total, deduplicated)

## Critical (3)
1. **Shared database across services** — All modules access the same DB, making
   decomposition impossible without a data migration strategy.
   - Source perspective: architecture, data-consistency

2. **No inter-service auth mechanism** — Current monolith relies on in-process
   session state. Migration requires a new token-based auth system.
   - Source perspective: security

...

## High (8)
...

## Medium (12)
...

## Low (5)
...
```

## CLI Command

```bash
npx js-breakdown "Analyze the current monolithic architecture and assess the feasibility of migrating to microservices. Consider security implications, performance impact, data consistency challenges, operational complexity, and developer experience."
```

## Expected Output

A deduplicated risk assessment report organized by severity, with each finding tagged by the perspective(s) that identified it. This gives the team a unified view of the migration challenges without reading 6 separate reports.

## Why by-perspective Instead of by-directory

A directory-based split would be wrong here because:
- The analysis targets the *entire system*, not individual directories
- Cross-cutting concerns (security, performance) span all directories
- The value comes from *synthesizing* multiple viewpoints, not partitioning scope

The by-perspective strategy lets each agent go deep on one angle while the aggregation layer handles overlap.
