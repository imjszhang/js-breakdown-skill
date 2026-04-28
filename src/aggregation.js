/**
 * Result aggregation — merges outputs from parallel subtask sessions
 * into a unified result appropriate to the task type.
 */

import { STRATEGY } from './breakdown.js';

// ── Delimiter ───────────────────────────────────────────────────────────────

const HR = '\n' + '─'.repeat(60) + '\n';

// ── Strategy: concatenate ───────────────────────────────────────────────────

/**
 * Simple concatenation for non-overlapping tasks (by-directory, by-feature).
 * Each subtask worked on a disjoint partition, so results are additive.
 */
function concatenate(results) {
  const sections = [];

  for (const r of results) {
    if (r.error) {
      sections.push([
        `## ${r.description} (${r.target})`,
        `> **FAILED**: ${r.error}`,
        '',
      ].join('\n'));
    } else {
      sections.push([
        `## ${r.description} (${r.target})`,
        `> Duration: ${formatDuration(r.durationMs)}`,
        '',
        r.output || '*No output*',
        '',
      ].join('\n'));
    }
  }

  return sections.join(HR);
}

// ── Strategy: merge-and-dedup ───────────────────────────────────────────────

/**
 * Merge overlapping analysis results (by-perspective).
 * Deduplicates findings that appear across multiple perspectives.
 */
function mergeAndDedup(results) {
  const allFindings = [];
  const seen = new Set();

  for (const r of results) {
    if (r.error) continue;

    const parsed = parseFindings(r.output);
    for (const finding of parsed) {
      const key = hashFinding(finding);
      if (!seen.has(key)) {
        seen.add(key);
        allFindings.push({ ...finding, source: r.target || r.description });
      }
    }
  }

  // Group by severity
  const critical = allFindings.filter(f => f.severity === 'critical');
  const high = allFindings.filter(f => f.severity === 'high');
  const medium = allFindings.filter(f => f.severity === 'medium');
  const low = allFindings.filter(f => f.severity === 'low');
  const info = allFindings.filter(f => !f.severity || f.severity === 'info');

  const severityOrder = [
    { label: 'Critical', items: critical },
    { label: 'High', items: high },
    { label: 'Medium', items: medium },
    { label: 'Low', items: low },
    { label: 'Info', items: info },
  ].filter(g => g.items.length > 0);

  return [
    `# Aggregated Findings (${allFindings.length} total, deduplicated)`,
    '',
    ...severityOrder.map(g =>
      `## ${g.label} (${g.items.length})\n\n` +
      g.items.map((f, i) =>
        `${i + 1}. **${f.title || 'Finding'}** — ${f.description || ''}\n` +
        `   - Source perspective: ${f.source || 'unknown'}`
      ).join('\n\n')
    ),
    '',
    '---',
    '',
    '### Raw Outputs',
    ...results.map(r => {
      const status = r.error ? 'FAILED' : `OK (${formatDuration(r.durationMs)})`;
      return `<details>\n<summary>${r.description} — ${status}</summary>\n\n\`\`\`\n${r.output || r.error || '*empty*'}\n\`\`\`\n</details>\n`;
    }),
  ].join('\n');
}

/**
 * Attempt to parse a result string into structured findings.
 * Handles markdown lists, numbered items, and "**Severity**: description" patterns.
 */
function parseFindings(text) {
  if (!text) return [];

  const findings = [];

  // Pattern 1: **Severity**: description  or  Severity: description
  const severityPattern = /\*?\*?\b(critical|high|medium|low|info)\b\*?\*?\s*:\s*(.+?)(?=\n|$)/gi;
  for (const m of text.matchAll(severityPattern)) {
    findings.push({
      severity: m[1].toLowerCase(),
      description: m[2].trim(),
      title: m[2].trim().slice(0, 80),
    });
  }

  // Pattern 2: Numbered or bulleted lists of findings
  if (findings.length === 0) {
    const listPattern = /(?:^|\n)\s*(?:[-*]|\d+[.)])\s+(.+)/gm;
    for (const m of text.matchAll(listPattern)) {
      const line = m[1].trim();
      // Try to extract severity from the line
      const sevMatch = line.match(/\b(critical|high|medium|low|info)\b/i);
      findings.push({
        severity: sevMatch ? sevMatch[1].toLowerCase() : 'info',
        description: line,
        title: line.slice(0, 80),
      });
    }
  }

  // Pattern 3: Fallback — whole sections as findings
  if (findings.length === 0 && text.trim()) {
    findings.push({
      severity: 'info',
      description: text.trim(),
      title: text.trim().slice(0, 80),
    });
  }

  return findings;
}

function hashFinding(f) {
  const normalized = (f.title + f.description).toLowerCase().replace(/\s+/g, ' ');
  // Simple hash for dedup
  let h = 0;
  for (let i = 0; i < normalized.length; i++) {
    h = ((h << 5) - h) + normalized.charCodeAt(i);
    h |= 0;
  }
  return `${f.severity}:${h}`;
}

// ── Strategy: summary extraction ────────────────────────────────────────────

/**
 * For pipeline stages: produce a stage-by-stage summary with stage ordering.
 */
function summarizePipeline(results) {
  const sorted = [...results].sort((a, b) => {
    const orderA = a._order ?? 99;
    const orderB = b._order ?? 99;
    return orderA - orderB;
  });

  const stages = sorted.map((r, i) => {
    const status = r.error ? 'FAILED' : 'COMPLETED';
    const icon = r.error ? '✗' : '✓';
    return [
      `## Stage ${i + 1}: ${r.description} ${icon}`,
      `> Status: ${status} | Duration: ${formatDuration(r.durationMs)}`,
      '',
      r.output || r.error || '*No output*',
      '',
    ].join('\n');
  });

  return [
    `# Pipeline Results`,
    `> ${sorted.filter(r => !r.error).length} of ${sorted.length} stages completed successfully`,
    '',
    ...stages,
  ].join('\n');
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Aggregate subtask results into a unified output.
 *
 * @param {Map<string, object>|object[]} results - Results from orchestrator
 * @param {object} [options]
 * @param {string} [options.strategy] - Force a specific aggregation strategy.
 *   Auto-selected from result metadata if omitted. One of:
 *   'concatenate', 'merge-dedup', 'summary'
 * @returns {string} Formatted markdown output
 */
export function aggregateResults(results, options = {}) {
  const arr = results instanceof Map ? [...results.values()] : results;

  // Determine strategy from the first non-error result
  const firstResult = arr.find(r => r.strategy);
  const strategy = options.strategy ?? strategyFromResult(firstResult);

  switch (strategy) {
    case 'merge-dedup':
    case STRATEGY.BY_PERSPECTIVE:
      return mergeAndDedup(arr);
    case 'summary':
    case STRATEGY.BY_PIPELINE:
      return summarizePipeline(arr);
    case 'concatenate':
    case STRATEGY.BY_DIRECTORY:
    case STRATEGY.BY_FEATURE:
    default:
      return concatenate(arr);
  }
}

/**
 * Derive the aggregation strategy from a result's decomposition strategy.
 */
function strategyFromResult(result) {
  if (!result || !result.strategy) return 'concatenate';

  switch (result.strategy) {
    case STRATEGY.BY_PERSPECTIVE:
      return 'merge-dedup';
    case STRATEGY.BY_PIPELINE:
      return 'summary';
    default:
      return 'concatenate';
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(ms) {
  if (ms == null) return '?';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}
