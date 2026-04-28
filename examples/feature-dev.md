# Example: Feature Development

## Scenario

The team needs to add a real-time notification system to a React + Express application. The work spans the database, API, WebSocket layer, frontend UI, and testing.

## Task Description

```
Add a real-time notification system:
1) Create notification model and database migration
2) Build notification API endpoints (CRUD + mark-read)
3) Set up WebSocket server for push delivery
4) Build notification bell component with unread badge
5) Write integration tests for the full notification flow
```

## What Happens

### Step 1: Analysis

```
Task type:    by-feature
Complexity:   8/10
Suggested N:  5

Detection logic:
  - Numbered list with 5 explicit items → N = 5
  - "add", "build", "create" → by-feature strategy
  - Cross-cutting concerns (WebSocket, database, tests) → high complexity
```

### Step 2: Decomposition

| Agent | Feature | Description |
|-------|---------|-------------|
| 1 | `notification-model` | Create model + DB migration |
| 2 | `notification-api` | CRUD endpoints + mark-read |
| 3 | `notification-websocket` | WebSocket server for push delivery |
| 4 | `notification-ui` | Bell component with unread badge |
| 5 | `notification-tests` | Integration tests for full flow |

### Step 3: Coordination Through Filesystem

```
.js-breakdown/
├── subtask-1/    ← Agent 1 writes: prisma/schema.prisma, migrations/
├── subtask-2/    ← Agent 2 writes: src/api/notifications.ts
├── subtask-3/    ← Agent 3 writes: src/ws/notification-handler.ts
├── subtask-4/    ← Agent 4 writes: src/components/NotificationBell.tsx
└── subtask-5/    ← Agent 5 writes: tests/notifications.test.ts
```

Each agent works in isolation. Since they're writing different files, no merge conflicts occur.

### Step 4: Aggregation (concatenation strategy)

The result is a combined markdown showing what each agent produced, with file paths and summaries.

## CLI Command

```bash
npx js-breakdown "Add a real-time notification system: 1) Create notification model and database migration 2) Build notification API endpoints (CRUD + mark-read) 3) Set up WebSocket server for push delivery 4) Build notification bell component with unread badge 5) Write integration tests for the full notification flow"
```

## Expected Output

Five sections, each with:
- The files created/modified by that agent
- A summary of the implementation
- Any notes about integration points with other features

## Key Design Decision

This is a **by-feature** decomposition because each subtask maps to a distinct functional module. The agents don't need to see each other's work — they just need the shared API contract (which should already exist or be specified in the task).
