import { describe, it, expect } from 'vitest';
import { analyzeTask, decompose, breakdown, STRATEGY } from '../src/breakdown.js';

// ── 注意 ────────────────────────────────────────────────────────────────────
// 这些测试覆盖的是 legacy/regex 模式的 API（analyzeTask, decompose, breakdown）。
// v2 推荐使用 agent-driven 模式：OpenClaw Agent 负责语义分析和任务拆分，
// js-breakdown 退化为纯粹的并行任务调度器。legacy 模式仅为 --legacy fallback 保留。
// ─────────────────────────────────────────────────────────────────────────────

// ── analyzeTask() tests ─────────────────────────────────────────────────────

describe('analyzeTask()', () => {
  // ── Strategy classification ──────────────────────────────────────────────

  it('should classify "format all files in src/components/" as by-directory', () => {
    const result = analyzeTask('format all files in src/components/');
    expect(result.taskType).toBe(STRATEGY.BY_DIRECTORY);
  });

  it('should classify "add dark mode feature to settings page" as by-feature', () => {
    const result = analyzeTask('add dark mode feature to the settings page');
    expect(result.taskType).toBe(STRATEGY.BY_FEATURE);
  });

  it('should classify "audit the codebase for security vulnerabilities" as by-perspective', () => {
    const result = analyzeTask('audit the codebase for security vulnerabilities');
    expect(result.taskType).toBe(STRATEGY.BY_PERSPECTIVE);
  });

  it('should classify "setup CI/CD pipeline for automated deployments" as by-pipeline', () => {
    const result = analyzeTask('setup CI/CD pipeline for automated deployments');
    expect(result.taskType).toBe(STRATEGY.BY_PIPELINE);
  });

  it('should classify "review the code for quality, security, and performance issues" as by-perspective', () => {
    const result = analyzeTask('review the code from multiple perspectives: quality, security, and performance');
    expect(result.taskType).toBe(STRATEGY.BY_PERSPECTIVE);
  });

  it('should classify "lint all the files in the project" as by-directory', () => {
    const result = analyzeTask('lint all the files in the project');
    expect(result.taskType).toBe(STRATEGY.BY_DIRECTORY);
  });

  it('should classify "migrate the database to the new schema" as by-pipeline', () => {
    const result = analyzeTask('migrate the database to the new schema');
    expect(result.taskType).toBe(STRATEGY.BY_PIPELINE);
  });

  it('should classify "add authentication feature" as by-feature', () => {
    const result = analyzeTask('add authentication feature');
    expect(result.taskType).toBe(STRATEGY.BY_FEATURE);
  });

  it('should classify "search codebase for research" as by-perspective', () => {
    const result = analyzeTask('research the best approach for state management in React');
    expect(result.taskType).toBe(STRATEGY.BY_PERSPECTIVE);
  });

  it('should classify "compare and contrast REST vs GraphQL" as by-perspective', () => {
    const result = analyzeTask('compare and contrast REST vs GraphQL for our API layer');
    expect(result.taskType).toBe(STRATEGY.BY_PERSPECTIVE);
  });

  // ── CJK support ──────────────────────────────────────────────────────────

  it('should classify "开发用户认证功能" as by-feature (Chinese)', () => {
    const result = analyzeTask('开发用户认证功能');
    expect(result.taskType).toBe(STRATEGY.BY_FEATURE);
  });

  it('should classify "审查代码安全性和性能" as by-perspective (Chinese)', () => {
    const result = analyzeTask('全面审查代码安全性和性能');
    expect(result.taskType).toBe(STRATEGY.BY_PERSPECTIVE);
  });

  it('should classify "执行部署流程" as by-pipeline (Chinese)', () => {
    const result = analyzeTask('执行部署流程');
    expect(result.taskType).toBe(STRATEGY.BY_PIPELINE);
  });

  it('should classify "整理所有文件" as by-directory (Chinese)', () => {
    const result = analyzeTask('整理所有代码文件');
    expect(result.taskType).toBe(STRATEGY.BY_DIRECTORY);
  });

  // ── Complexity scoring ────────────────────────────────────────────────────

  it('should return complexity 1 for a very simple task', () => {
    const result = analyzeTask('fix bug');
    expect(result.complexity).toBeGreaterThanOrEqual(1);
  });

  it('should return higher complexity for a detailed technical task', () => {
    const result = analyzeTask(
      'Refactor the authentication module with security audit, performance optimization, ' +
      'database migration, comprehensive testing, and API documentation updates'
    );
    expect(result.complexity).toBeGreaterThanOrEqual(4);
  });

  // ── Explicit item extraction ──────────────────────────────────────────────

  it('should extract explicit items from oxford-comma lists', () => {
    const result = analyzeTask('fix bugs in src/api/, src/components/, and src/utils/.');
    expect(result.explicitItems).toEqual(['src/api/', 'src/components/', 'src/utils/']);
  });

  it('should extract explicit items from numbered lists', () => {
    const result = analyzeTask('1) setup database 2) write API 3) build UI');
    expect(result.explicitItems).toEqual(['setup database', 'write API', 'build UI']);
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('should handle empty string gracefully', () => {
    const result = analyzeTask('');
    expect(result.taskType).toBe(STRATEGY.BY_DIRECTORY);
    expect(result.suggestedN).toBeGreaterThanOrEqual(2);
    expect(result.complexity).toBeGreaterThanOrEqual(1);
    expect(result.explicitItems).toBeNull();
  });

  it('should return suggestedN within bounds for any input', () => {
    const result = analyzeTask('some task');
    expect(result.suggestedN).toBeGreaterThanOrEqual(2);
    expect(result.suggestedN).toBeLessThanOrEqual(8);
  });

  // ── Config overrides ──────────────────────────────────────────────────────

  it('should respect custom maxConcurrentSessions', () => {
    const result = analyzeTask('add feature A, feature B, feature C, feature D, feature E', {
      maxConcurrentSessions: 3,
    });
    expect(result.suggestedN).toBeLessThanOrEqual(3);
  });

  it('should respect custom minParallelism', () => {
    const result = analyzeTask('simple task', { minParallelism: 4 });
    expect(result.suggestedN).toBeGreaterThanOrEqual(4);
  });
});

// ── decompose() tests ───────────────────────────────────────────────────────

describe('decompose()', () => {
  // ── by-directory with explicit items ──────────────────────────────────────

  it('should decompose by-directory with explicit directory items', () => {
    const subtasks = decompose('review code', 3, {
      taskType: STRATEGY.BY_DIRECTORY,
      explicitItems: ['src/api/', 'src/components/', 'src/utils/'],
    });
    expect(subtasks).toHaveLength(3);
    expect(subtasks[0].strategy).toBe(STRATEGY.BY_DIRECTORY);
    expect(subtasks[0].target).toBe('src/api/');
    expect(subtasks[1].target).toBe('src/components/');
    expect(subtasks[2].target).toBe('src/utils/');
  });

  // ── by-feature with explicit items ────────────────────────────────────────

  it('should decompose by-feature with explicit feature items', () => {
    const subtasks = decompose('refactor modules', 3, {
      taskType: STRATEGY.BY_FEATURE,
      explicitItems: ['auth module', 'billing module', 'profile module'],
    });
    expect(subtasks).toHaveLength(3);
    expect(subtasks[0].strategy).toBe(STRATEGY.BY_FEATURE);
    expect(subtasks[0].description).toContain('auth module');
    expect(subtasks[1].description).toContain('billing module');
    expect(subtasks[2].description).toContain('profile module');
  });

  // ── by-perspective with explicit items ────────────────────────────────────

  it('should decompose by-perspective with explicit perspective items', () => {
    const subtasks = decompose('analyze the system', 3, {
      taskType: STRATEGY.BY_PERSPECTIVE,
      explicitItems: ['security', 'performance', 'maintainability'],
    });
    expect(subtasks).toHaveLength(3);
    expect(subtasks[0].strategy).toBe(STRATEGY.BY_PERSPECTIVE);
    expect(subtasks[0].target).toBe('security');
    expect(subtasks[0].description).toContain('security');
    expect(subtasks[1].target).toBe('performance');
    expect(subtasks[2].target).toBe('maintainability');
  });

  // ── by-pipeline with explicit items ───────────────────────────────────────

  it('should decompose by-pipeline with explicit stage items', () => {
    const subtasks = decompose('migrate data', 3, {
      taskType: STRATEGY.BY_PIPELINE,
      explicitItems: ['extract data', 'transform schema', 'load into warehouse'],
    });
    expect(subtasks).toHaveLength(3);
    expect(subtasks[0].strategy).toBe(STRATEGY.BY_PIPELINE);
    expect(subtasks[0].order).toBe(0);
    expect(subtasks[1].order).toBe(1);
    expect(subtasks[2].order).toBe(2);
    expect(subtasks[0].description).toContain('extract data');
  });

  // ── by-directory without explicit items ───────────────────────────────────

  it('should produce generic partitions for by-directory without items', () => {
    const subtasks = decompose('process all files', 2, {
      taskType: STRATEGY.BY_DIRECTORY,
    });
    expect(subtasks).toHaveLength(2);
    expect(subtasks[0].strategy).toBe(STRATEGY.BY_DIRECTORY);
    expect(subtasks[0].target).toContain('partition');
    expect(subtasks[1].target).toContain('partition');
  });

  // ── by-feature without explicit items ─────────────────────────────────────

  it('should produce generic modules for by-feature without items', () => {
    const subtasks = decompose('add features', 3, {
      taskType: STRATEGY.BY_FEATURE,
    });
    expect(subtasks).toHaveLength(3);
    expect(subtasks[0].strategy).toBe(STRATEGY.BY_FEATURE);
    expect(subtasks[0].target).toContain('module');
  });

  // ── by-perspective without explicit items (uses perspective pool) ─────────

  it('should auto-select perspectives from the pool for by-perspective without items', () => {
    const subtasks = decompose('review the codebase', 3, {
      taskType: STRATEGY.BY_PERSPECTIVE,
    });
    expect(subtasks).toHaveLength(3);
    expect(subtasks[0].strategy).toBe(STRATEGY.BY_PERSPECTIVE);
    // Should pick 3 unique perspectives from the pool
    const targets = subtasks.map(s => s.target);
    const uniqueTargets = new Set(targets);
    expect(uniqueTargets.size).toBe(3);
  });

  // ── by-pipeline without explicit items ────────────────────────────────────

  it('should produce generic stages for by-pipeline without items', () => {
    const subtasks = decompose('run pipeline', 2, {
      taskType: STRATEGY.BY_PIPELINE,
    });
    expect(subtasks).toHaveLength(2);
    expect(subtasks[0].strategy).toBe(STRATEGY.BY_PIPELINE);
    expect(subtasks[0].order).toBe(0);
    expect(subtasks[1].order).toBe(1);
    expect(subtasks[0].target).toContain('stage');
  });

  // ── Auto-detect strategy ──────────────────────────────────────────────────

  it('should auto-detect strategy when taskType is not provided', () => {
    const subtasks = decompose('audit the API for security vulnerabilities', 3);
    expect(subtasks).toHaveLength(3);
    expect(subtasks[0].strategy).toBe(STRATEGY.BY_PERSPECTIVE);
  });

  // ── Custom N value ────────────────────────────────────────────────────────

  it('should produce exactly N subtasks', () => {
    const subtasks = decompose('add features', 5, {
      taskType: STRATEGY.BY_FEATURE,
    });
    expect(subtasks).toHaveLength(5);
  });

  // ── All subtasks have required fields ─────────────────────────────────────

  it('should produce subtasks with all required fields', () => {
    const subtasks = decompose('refactor code', 2, {
      taskType: STRATEGY.BY_FEATURE,
      explicitItems: ['auth', 'billing'],
    });
    for (const st of subtasks) {
      expect(st).toHaveProperty('id');
      expect(st).toHaveProperty('description');
      expect(st).toHaveProperty('strategy');
      expect(st).toHaveProperty('target');
      expect(st).toHaveProperty('prompt');
      expect(typeof st.prompt).toBe('string');
      expect(st.prompt.length).toBeGreaterThan(0);
    }
  });
});

// ── breakdown() tests ────────────────────────────────────────────────────────

describe('breakdown()', () => {
  it('should return analysis and subtasks in one call', () => {
    const result = breakdown('audit the codebase for security vulnerabilities');
    expect(result).toHaveProperty('analysis');
    expect(result).toHaveProperty('subtasks');
    expect(result.analysis.taskType).toBe(STRATEGY.BY_PERSPECTIVE);
    expect(result.subtasks.length).toBeGreaterThanOrEqual(2);
  });

  it('should use explicitItems from analysis in subtask decomposition', () => {
    const result = breakdown('fix bugs in src/api/, src/components/, and src/utils/.');
    expect(result.analysis.explicitItems).toHaveLength(3);
    expect(result.subtasks.length).toBeLessThanOrEqual(result.analysis.explicitItems.length);
  });

  it('should pass config options through', () => {
    const result = breakdown('simple task', { maxConcurrentSessions: 4, minParallelism: 2 });
    expect(result.analysis.suggestedN).toBeLessThanOrEqual(4);
    expect(result.analysis.suggestedN).toBeGreaterThanOrEqual(2);
  });
});
