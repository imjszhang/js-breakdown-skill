/**
 * Session orchestration — spawns, monitors, and aggregates parallel
 * Claude Code sessions via ACP (Agent Communication Protocol).
 *
 * Abstraction: the module accepts a `spawnFn` (session factory) so it can
 * work with the real Anthropic ACP SDK, a mock for testing, or a CLI
 * subprocess adapter.
 */

import { EventEmitter } from 'node:events';
import path from 'node:path';

// ── Default config ──────────────────────────────────────────────────────────

const DEFAULTS = {
  maxConcurrent: 8,
  retryCount: 2,
  workDir: '.js-breakdown',
  pollIntervalMs: 500,
};

// ── Session state enum ──────────────────────────────────────────────────────

const STATE = {
  PENDING:  'pending',
  RUNNING:  'running',
  DONE:     'done',
  FAILED:   'failed',
  RETRYING: 'retrying',
};

// ── Orchestrator ────────────────────────────────────────────────────────────

export class Orchestrator extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {Function} options.spawnFn - (subtask, workDir) => Promise<SessionHandle>
   * @param {number} [options.maxConcurrent=8]
   * @param {number} [options.retryCount=2]
   * @param {string} [options.workDir='.js-breakdown']
   * @param {number} [options.pollIntervalMs=500]
   */
  constructor(options = {}) {
    super();
    this._config = { ...DEFAULTS, ...options };
    this._spawnFn = options.spawnFn || null;
    this._sessions = new Map();   // id → { subtask, handle, state, retries, startTime }
    this._results = new Map();     // id → result or error
    this._running = new Set();     // ids currently running
    this._queue = [];              // pending subtask ids
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Spawn all subtasks respecting maxConcurrent.
   * Returns a promise that resolves when all sessions complete (or fail fatally).
   *
   * @param {object[]} subtasks - Array of subtask plans from breakdown.decompose()
   * @param {string} cwd - Working directory for the sessions
   * @param {number} [maxConcurrent] - Override the configured maxConcurrent
   * @returns {Promise<Map<string, object>>} Map of subtask.id → result
   */
  async spawnParallelSessions(subtasks, cwd, maxConcurrent) {
    const concurrency = maxConcurrent ?? this._config.maxConcurrent;

    // Initialize session tracking
    for (const st of subtasks) {
      this._sessions.set(st.id, {
        subtask: st,
        handle: null,
        state: STATE.PENDING,
        retries: 0,
        startTime: null,
      });
      this._queue.push(st.id);
    }

    this.emit('start', { total: subtasks.length, concurrency });

    // Process queue with concurrency limit
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(this._worker(cwd));
    }

    await Promise.all(workers);

    this.emit('complete', {
      total: subtasks.length,
      succeeded: [...this._results.values()].filter(r => !r.error).length,
      failed: [...this._results.values()].filter(r => r.error).length,
    });

    return this._results;
  }

  /**
   * Wait for all sessions to finish. This is implicitly called by
   * spawnParallelSessions, but exposed for cases where sessions were
   * started externally.
   */
  async waitForAll() {
    while (this._running.size > 0 || this._queue.length > 0) {
      await this._sleep(this._config.pollIntervalMs);
    }
  }

  /**
   * Convenience: spawn and wait, returning results as an array.
   */
  async runAll(subtasks, cwd, maxConcurrent) {
    const results = await this.spawnParallelSessions(subtasks, cwd, maxConcurrent);
    return [...results.values()];
  }

  // ── Internal worker ─────────────────────────────────────────────────────

  async _worker(cwd) {
    while (this._queue.length > 0) {
      const id = this._queue.shift();
      if (!id) break;

      await this._execute(id, cwd);
    }
  }

  async _execute(id, cwd) {
    const session = this._sessions.get(id);
    if (!session) return;

    session.state = STATE.RUNNING;
    session.startTime = Date.now();
    this._running.add(id);

    this.emit('session:start', { id, description: session.subtask.description });

    try {
      if (!this._spawnFn) {
        throw new Error('No spawnFn configured. Set options.spawnFn in the Orchestrator constructor.');
      }

      const workDir = path.join(cwd, this._config.workDir, id);
      const handle = await this._spawnFn(session.subtask, workDir);
      session.handle = handle;

      // Wait for the session to produce a result
      const result = await handle.wait();
      session.state = STATE.DONE;
      this._results.set(id, {
        id,
        description: session.subtask.description,
        target: session.subtask.target,
        strategy: session.subtask.strategy,
        order: session.subtask.order,
        output: result,
        durationMs: Date.now() - session.startTime,
      });

      this.emit('session:done', { id, durationMs: Date.now() - session.startTime });
    } catch (err) {
      if (session.retries < this._config.retryCount) {
        session.state = STATE.RETRYING;
        session.retries++;
        this.emit('session:retry', { id, attempt: session.retries, error: err.message });

        // Re-queue for retry
        this._queue.push(id);
      } else {
        session.state = STATE.FAILED;
        this._results.set(id, {
          id,
          description: session.subtask.description,
          target: session.subtask.target,
          strategy: session.subtask.strategy,
          order: session.subtask.order,
          error: err.message,
          retries: session.retries,
          durationMs: Date.now() - session.startTime,
        });
        this.emit('session:fail', { id, error: err.message });
      }
    } finally {
      this._running.delete(id);
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ── CLI subprocess adapter ──────────────────────────────────────────────────

/**
 * Spawn function that launches Claude Code as a subprocess (standalone/CLI mode).
 * Falls back gracefully when the SDK isn't available.
 *
 * @param {object} subtask
 * @param {string} workDir
 * @returns {Promise<{ wait: () => Promise<string> }>}
 */
export async function cliSpawnFn(subtask, workDir) {
  const { spawn } = await import('node:child_process');
  const { mkdir, writeFile } = await import('node:fs/promises');

  await mkdir(workDir, { recursive: true });

  // Write the subtask prompt to a file for the agent to read
  await writeFile(path.join(workDir, 'task.md'), subtask.prompt, 'utf-8');

  return {
    wait: () => {
      return new Promise((resolve, reject) => {
        // Attempt to use claude (Claude Code CLI)
        const child = spawn('claude', [
          '--print',
          '--verbose',
          `--output-format=text`,
          '-p', subtask.prompt,
        ], {
          cwd: workDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 600_000, // 10 minute timeout per subtask
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });

        child.on('close', code => {
          if (code === 0) {
            resolve(stdout.trim());
          } else {
            reject(new Error(`claude exited with code ${code}: ${stderr.trim()}`));
          }
        });

        child.on('error', err => {
          reject(new Error(`Failed to spawn claude CLI: ${err.message}. Is claude installed?`));
        });
      });
    },
  };
}

// ── Mock spawn (for testing / dry-run) ──────────────────────────────────────

/**
 * Mock spawn function for testing. Returns a fake result after a short delay.
 */
export function mockSpawnFn(delayMs = 100) {
  return async (subtask, _workDir) => ({
    wait: async () => {
      await new Promise(r => setTimeout(r, delayMs));
      return `[mock result for "${subtask.description}"]`;
    },
  });
}
