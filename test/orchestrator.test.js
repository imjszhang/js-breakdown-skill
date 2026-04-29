import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator, mockSpawnFn } from '../src/orchestrator.js';
import { STRATEGY } from '../src/breakdown.js';

// ── 注意 ────────────────────────────────────────────────────────────────────
// Orchestrator 在 v2 中保持不变：agent-driven 和 legacy 模式共用同一套
// 并发调度 + 重试逻辑。Agent 负责拆分决策，Orchestrator 负责并行执行管理。
// ─────────────────────────────────────────────────────────────────────────────

// Helper: create minimal subtask objects
function makeSubtasks(count, strategy = STRATEGY.BY_FEATURE) {
  return Array.from({ length: count }, (_, i) => ({
    id: `subtask-${i + 1}`,
    description: `Test subtask ${i + 1}`,
    strategy,
    target: `target-${i + 1}`,
    prompt: `Execute test subtask ${i + 1}`,
  }));
}

// ── Orchestrator with mockSpawnFn ────────────────────────────────────────────

describe('Orchestrator with mockSpawnFn', () => {
  let orchestrator;

  beforeEach(() => {
    orchestrator = null;
  });

  it('should execute a single subtask successfully', async () => {
    const mockSpawn = mockSpawnFn(10);
    const orch = new Orchestrator({
      spawnFn: mockSpawn,
      maxConcurrent: 2,
      retryCount: 0,
    });

    const subtasks = makeSubtasks(1);
    const results = await orch.spawnParallelSessions(subtasks, '/tmp/test-orch');

    expect(results.size).toBe(1);
    const result = results.get('subtask-1');
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('[mock result for "Test subtask 1"]');
    expect(result.strategy).toBe(STRATEGY.BY_FEATURE);
    expect(result.target).toBe('target-1');
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should execute multiple subtasks in parallel', async () => {
    const mockSpawn = mockSpawnFn(10);
    const orch = new Orchestrator({
      spawnFn: mockSpawn,
      maxConcurrent: 4,
      retryCount: 0,
    });

    const subtasks = makeSubtasks(6);
    const startTime = Date.now();
    const results = await orch.spawnParallelSessions(subtasks, '/tmp/test-orch');
    const elapsed = Date.now() - startTime;

    expect(results.size).toBe(6);
    for (let i = 1; i <= 6; i++) {
      const result = results.get(`subtask-${i}`);
      expect(result.error).toBeUndefined();
      expect(result.output).toContain(`[mock result for "Test subtask ${i}"]`);
    }

    // With maxConcurrent=4 and 6 tasks, should finish faster than sequential
    // Each mock takes 10ms, so worst case serial would be 60ms, parallel ~20ms
    expect(elapsed).toBeLessThan(500);
  });

  it('should respect maxConcurrent limit', async () => {
    // Track how many are running concurrently
    let concurrent = 0;
    let maxConcurrentObserved = 0;

    const trackedSpawn = async (subtask, _workDir) => {
      concurrent++;
      maxConcurrentObserved = Math.max(maxConcurrentObserved, concurrent);
      return {
        wait: async () => {
          await new Promise(r => setTimeout(r, 10));
          concurrent--;
          return `[result for ${subtask.description}]`;
        },
      };
    };

    const orch = new Orchestrator({
      spawnFn: trackedSpawn,
      maxConcurrent: 2,
      retryCount: 0,
    });

    const subtasks = makeSubtasks(5);
    await orch.spawnParallelSessions(subtasks, '/tmp/test-orch');

    expect(maxConcurrentObserved).toBeLessThanOrEqual(2);
  });

  it('should retry on failure and succeed', async () => {
    // First call fails, subsequent calls succeed
    let callCount = 0;

    const flakySpawn = async (subtask, _workDir) => ({
      wait: async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Temporary network error');
        }
        return `[result after retry for ${subtask.description}]`;
      },
    });

    const orch = new Orchestrator({
      spawnFn: flakySpawn,
      maxConcurrent: 1,
      retryCount: 1,
    });

    const retryEvents = [];
    orch.on('session:retry', (evt) => {
      retryEvents.push(evt);
    });

    const subtasks = makeSubtasks(1);
    const results = await orch.spawnParallelSessions(subtasks, '/tmp/test-orch');

    expect(callCount).toBe(2); // initial + 1 retry
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0].attempt).toBe(1);
    expect(retryEvents[0].error).toContain('Temporary network error');

    const result = results.get('subtask-1');
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('after retry');
  });

  it('should fail after exhausting retries', async () => {
    const alwaysFailSpawn = async (_subtask, _workDir) => ({
      wait: async () => {
        throw new Error('Persistent failure');
      },
    });

    const orch = new Orchestrator({
      spawnFn: alwaysFailSpawn,
      maxConcurrent: 1,
      retryCount: 2, // 2 retries means 3 total attempts
    });

    const failEvents = [];
    orch.on('session:fail', (evt) => {
      failEvents.push(evt);
    });

    const subtasks = makeSubtasks(1);
    const results = await orch.spawnParallelSessions(subtasks, '/tmp/test-orch');

    expect(failEvents).toHaveLength(1);
    expect(failEvents[0].error).toContain('Persistent failure');

    const result = results.get('subtask-1');
    expect(result.error).toContain('Persistent failure');
    expect(result.retries).toBe(2);
  });

  it('should emit lifecycle events', async () => {
    const mockSpawn = mockSpawnFn(5);
    const orch = new Orchestrator({
      spawnFn: mockSpawn,
      maxConcurrent: 2,
      retryCount: 0,
    });

    const events = [];
    orch.on('start', (evt) => events.push({ type: 'start', ...evt }));
    orch.on('session:start', (evt) => events.push({ type: 'session:start', ...evt }));
    orch.on('session:done', (evt) => events.push({ type: 'session:done', ...evt }));
    orch.on('complete', (evt) => events.push({ type: 'complete', ...evt }));

    const subtasks = makeSubtasks(3);
    await orch.spawnParallelSessions(subtasks, '/tmp/test-orch');

    expect(events.filter(e => e.type === 'start')).toHaveLength(1);
    expect(events.filter(e => e.type === 'session:start')).toHaveLength(3);
    expect(events.filter(e => e.type === 'session:done')).toHaveLength(3);
    expect(events.filter(e => e.type === 'complete')).toHaveLength(1);

    const completeEvent = events.find(e => e.type === 'complete');
    expect(completeEvent.total).toBe(3);
    expect(completeEvent.succeeded).toBe(3);
    expect(completeEvent.failed).toBe(0);
  });

  it('should report failed count correctly in complete event', async () => {
    let call = 0;
    const mixedSpawn = async (subtask, _workDir) => ({
      wait: async () => {
        call++;
        if (call % 2 === 0) {
          throw new Error('Even call failure');
        }
        return `[result for ${subtask.description}]`;
      },
    });

    const orch = new Orchestrator({
      spawnFn: mixedSpawn,
      maxConcurrent: 2,
      retryCount: 0,
    });

    const subtasks = makeSubtasks(4);
    const results = await orch.spawnParallelSessions(subtasks, '/tmp/test-orch');

    const errors = [...results.values()].filter(r => r.error);
    const successes = [...results.values()].filter(r => !r.error);
    expect(errors.length).toBeGreaterThan(0);
    expect(successes.length).toBeGreaterThan(0);
    expect(errors.length + successes.length).toBe(4);
  });

  it('should store subtask metadata in results', async () => {
    const mockSpawn = mockSpawnFn(5);
    const orch = new Orchestrator({
      spawnFn: mockSpawn,
      maxConcurrent: 2,
      retryCount: 0,
    });

    const subtasks = makeSubtasks(2, STRATEGY.BY_PIPELINE);
    // Add order for pipeline subtasks
    subtasks[0].order = 0;
    subtasks[1].order = 1;

    const results = await orch.spawnParallelSessions(subtasks, '/tmp/test-orch');

    for (const result of results.values()) {
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('description');
      expect(result).toHaveProperty('target');
      expect(result).toHaveProperty('strategy');
      expect(result).toHaveProperty('output');
      expect(result).toHaveProperty('durationMs');
    }
  });

  it('should return results as Map from spawnParallelSessions', async () => {
    const mockSpawn = mockSpawnFn(5);
    const orch = new Orchestrator({ spawnFn: mockSpawn, retryCount: 0 });

    const subtasks = makeSubtasks(2);
    const results = await orch.spawnParallelSessions(subtasks, '/tmp/test-orch');

    expect(results).toBeInstanceOf(Map);
    expect(results.size).toBe(2);
  });
});
