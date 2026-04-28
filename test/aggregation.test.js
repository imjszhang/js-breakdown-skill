import { describe, it, expect } from 'vitest';
import { aggregateResults } from '../src/aggregation.js';
import { STRATEGY } from '../src/breakdown.js';

// Helper: create minimal result objects
function makeResult(overrides = {}) {
  return {
    id: 'subtask-1',
    description: 'Test subtask',
    target: 'target-1',
    strategy: STRATEGY.BY_FEATURE,
    output: 'Task completed successfully.',
    durationMs: 1500,
    ...overrides,
  };
}

// ── concatenate strategy ────────────────────────────────────────────────────

describe('aggregateResults — concatenate', () => {
  it('should concatenate results for by-directory strategy', () => {
    const results = [
      makeResult({ id: 's1', description: 'Auth module', strategy: STRATEGY.BY_DIRECTORY, target: 'src/auth/', output: 'Auth reviewed.' }),
      makeResult({ id: 's2', description: 'API module', strategy: STRATEGY.BY_DIRECTORY, target: 'src/api/', output: 'API reviewed.' }),
    ];

    const output = aggregateResults(results);
    expect(output).toContain('Auth module');
    expect(output).toContain('API module');
    expect(output).toContain('Auth reviewed.');
    expect(output).toContain('API reviewed.');
    // Should use horizontal rule separator
    expect(output).toContain('─');
  });

  it('should concatenate results for by-feature strategy', () => {
    const results = [
      makeResult({ id: 'f1', description: 'Dark mode', strategy: STRATEGY.BY_FEATURE, target: 'dark-mode', output: 'Done.' }),
      makeResult({ id: 'f2', description: 'i18n', strategy: STRATEGY.BY_FEATURE, target: 'i18n', output: 'Done.' }),
      makeResult({ id: 'f3', description: 'A11y', strategy: STRATEGY.BY_FEATURE, target: 'a11y', output: 'Done.' }),
    ];

    const output = aggregateResults(results);
    expect(output).toContain('Dark mode');
    expect(output).toContain('i18n');
    expect(output).toContain('A11y');
  });

  it('should include error information in concatenated output', () => {
    const results = [
      makeResult({ id: 's1', description: 'Good task', strategy: STRATEGY.BY_DIRECTORY, output: 'Success.' }),
      makeResult({ id: 's2', description: 'Failed task', strategy: STRATEGY.BY_DIRECTORY, output: undefined, error: 'Connection refused' }),
    ];

    const output = aggregateResults(results);
    expect(output).toContain('Good task');
    expect(output).toContain('Failed task');
    expect(output).toContain('FAILED');
    expect(output).toContain('Connection refused');
  });

  it('should handle a single result', () => {
    const results = [
      makeResult({ id: 's1', description: 'Solo task', strategy: STRATEGY.BY_DIRECTORY, output: 'Only result.' }),
    ];

    const output = aggregateResults(results);
    expect(output).toContain('Solo task');
    expect(output).toContain('Only result.');
  });
});

// ── merge-dedup strategy ────────────────────────────────────────────────────

describe('aggregateResults — merge-dedup', () => {
  it('should deduplicate findings across perspectives', () => {
    const sharedFinding = '**Critical**: SQL injection vulnerability in user input handling';
    const results = [
      makeResult({ id: 'p1', description: 'Security', strategy: STRATEGY.BY_PERSPECTIVE, target: 'security', output: sharedFinding }),
      makeResult({ id: 'p2', description: 'Performance', strategy: STRATEGY.BY_PERSPECTIVE, target: 'performance', output: sharedFinding }),
    ];

    const output = aggregateResults(results);
    expect(output).toContain('Aggregated Findings');
    expect(output).toContain('deduplicated');
    // Dedup should produce exactly 1 finding (not 2), verified via the header count
    expect(output).toContain('(1 total, deduplicated)');
    // The finding should appear under Critical section
    expect(output).toContain('SQL injection');
  });

  it('should group findings by severity', () => {
    const results = [
      makeResult({
        id: 'p1', description: 'Security review', strategy: STRATEGY.BY_PERSPECTIVE, target: 'security',
        output: '**Critical**: RCE via deserialization\n**Low**: Missing CSP header',
      }),
      makeResult({
        id: 'p2', description: 'Performance review', strategy: STRATEGY.BY_PERSPECTIVE, target: 'performance',
        output: '**High**: N+1 query in product list\n**Medium**: Unoptimized images',
      }),
    ];

    const output = aggregateResults(results);
    expect(output).toContain('Critical');
    expect(output).toContain('High');
    expect(output).toContain('Medium');
    expect(output).toContain('Low');
  });

  it('should parse bulleted list findings', () => {
    const results = [
      makeResult({
        id: 'p1', description: 'Code review', strategy: STRATEGY.BY_PERSPECTIVE, target: 'maintainability',
        output: '- critical: Broken auth in middleware\n- Duplicate code in utils\n- Missing error handling in API',
      }),
    ];

    const output = aggregateResults(results);
    expect(output).toContain('Aggregated Findings');
    expect(output).toContain('Broken auth');
  });

  it('should use source perspective in output', () => {
    const results = [
      makeResult({ id: 'p1', description: 'Security', strategy: STRATEGY.BY_PERSPECTIVE, target: 'security', output: '**Info**: All good' }),
    ];

    const output = aggregateResults(results);
    expect(output).toContain('security');
  });
});

// ── summary strategy (pipeline) ─────────────────────────────────────────────

describe('aggregateResults — summary (pipeline)', () => {
  it('should summarize pipeline results with stage ordering', () => {
    const results = [
      makeResult({ id: 'st1', description: 'Stage 1: Extract', strategy: STRATEGY.BY_PIPELINE, target: 'stage-1', order: 0, output: 'Extraction complete: 1000 rows.' }),
      makeResult({ id: 'st2', description: 'Stage 2: Transform', strategy: STRATEGY.BY_PIPELINE, target: 'stage-2', order: 1, output: 'Transformation complete: normalized schema.' }),
      makeResult({ id: 'st3', description: 'Stage 3: Load', strategy: STRATEGY.BY_PIPELINE, target: 'stage-3', order: 2, output: 'Load complete: 1000 rows inserted.' }),
    ];

    const output = aggregateResults(results);
    expect(output).toContain('Pipeline Results');
    expect(output).toContain('Extract');
    expect(output).toContain('Transform');
    expect(output).toContain('Load');
    expect(output).toContain('3 of 3 stages completed successfully');
    expect(output).toContain('✓');
  });

  it('should handle pipeline with failed stages', () => {
    const results = [
      makeResult({ id: 'st1', description: 'Stage 1: Setup', strategy: STRATEGY.BY_PIPELINE, target: 'stage-1', order: 0, output: 'Setup done.' }),
      makeResult({ id: 'st2', description: 'Stage 2: Process', strategy: STRATEGY.BY_PIPELINE, target: 'stage-2', order: 1, error: 'Out of memory', output: undefined }),
    ];

    const output = aggregateResults(results);
    expect(output).toContain('Pipeline Results');
    expect(output).toContain('1 of 2 stages completed successfully');
    expect(output).toContain('FAILED');
    expect(output).toContain('Out of memory');
    expect(output).toContain('✗');
  });

  it('should sort pipeline stages by order regardless of input order', () => {
    const results = [
      makeResult({ id: 'st2', description: 'Stage 2', strategy: STRATEGY.BY_PIPELINE, target: 'stage-2', order: 1, output: 'Second.' }),
      makeResult({ id: 'st1', description: 'Stage 1', strategy: STRATEGY.BY_PIPELINE, target: 'stage-1', order: 0, output: 'First.' }),
      makeResult({ id: 'st3', description: 'Stage 3', strategy: STRATEGY.BY_PIPELINE, target: 'stage-3', order: 2, output: 'Third.' }),
    ];

    const output = aggregateResults(results);
    const firstIdx = output.indexOf('First.');
    const secondIdx = output.indexOf('Second.');
    const thirdIdx = output.indexOf('Third.');
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe('aggregateResults — edge cases', () => {
  it('should handle empty results array', () => {
    const output = aggregateResults([]);
    expect(output).toBe('');
  });

  it('should handle a Map input', () => {
    const resultMap = new Map();
    resultMap.set('s1', makeResult({ id: 's1', description: 'Map task', strategy: STRATEGY.BY_FEATURE, output: 'Map result.' }));

    const output = aggregateResults(resultMap);
    expect(output).toContain('Map task');
    expect(output).toContain('Map result.');
  });

  it('should handle results with missing output gracefully', () => {
    const results = [
      makeResult({ id: 's1', description: 'Silent task', strategy: STRATEGY.BY_DIRECTORY, output: '' }),
    ];

    const output = aggregateResults(results);
    expect(output).toContain('Silent task');
    expect(output).toContain('*No output*');
  });

  it('should fall back to concatenate for unknown strategy', () => {
    const results = [
      makeResult({ id: 's1', description: 'Unknown strategy task', strategy: 'unknown-type', output: 'Result.' }),
    ];

    const output = aggregateResults(results);
    // Should not throw and should use concatenate fallback
    expect(output).toContain('Unknown strategy task');
    expect(output).toContain('Result.');
  });

  it('should use explicit strategy override option', () => {
    const results = [
      makeResult({ id: 'st1', description: 'Stage 1', strategy: STRATEGY.BY_PIPELINE, target: 'stage-1', order: 0, output: 'Done.' }),
    ];

    // Force concatenate instead of pipeline summary
    const output = aggregateResults(results, { strategy: 'concatenate' });
    expect(output).not.toContain('Pipeline Results');
    expect(output).toContain('Stage 1');
    expect(output).toContain('Done.');
  });

  it('should handle results with null durationMs', () => {
    const results = [
      makeResult({ id: 's1', description: 'No duration', strategy: STRATEGY.BY_FEATURE, durationMs: null, output: 'Result.' }),
    ];

    const output = aggregateResults(results);
    expect(output).toContain('?'); // formatDuration returns '?' for null/undefined
  });
});
