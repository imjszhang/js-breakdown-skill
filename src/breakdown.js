/**
 * Core decomposition logic for js-breakdown.
 *
 * Analyzes a natural-language task description and produces N independent
 * subtask plans optimized for parallel execution by Claude Code agents.
 */

// ── Strategy types ──────────────────────────────────────────────────────────

export const STRATEGY = Object.freeze({
  BY_DIRECTORY:   'by-directory',
  BY_FEATURE:     'by-feature',
  BY_PERSPECTIVE: 'by-perspective',
  BY_PIPELINE:    'by-pipeline',
});

// ── Default config ──────────────────────────────────────────────────────────

const DEFAULTS = {
  maxConcurrentSessions: 8,
  defaultParallelism: 4,
  minParallelism: 2,
};

// ── Keyword → strategy mapping (first-match wins, checked in order) ─────────
// Order matters: more-specific patterns should come before generic ones.
// BY_PERSPECTIVE is checked first because security/audit/review-for-quality
// patterns are more specific than general directory/code-review patterns.

// ── Helper: build a non-ASCII-aware pattern that works with CJK text ──
// \b (word boundary) doesn't work between CJK characters. We use (?:^|[\s:：,，;；（(])
// and (?:$|[\s:：,，;；）)]) as CJK-safe boundaries.
const CJK_START = '(?:^|[\\s:：,，;；（(])';
const CJK_END = '(?:$|[\\s:：,，;；）)])';

// ── IMPORTANT: CJK by-feature patterns are checked BEFORE by-perspective ──
// because CJK multi-feature lists (A、B、C) easily match the broad by-perspective patterns.
const CJK_FEATURE_PATTERNS = [
  // Chinese: explicit "补充/添加/实现/编写/增加" + enumerated items (A、B、C)
  /[补充添加实现编写增加]+.*[、][^、\n]+[、]/,
  // Chinese: 开发/创建 ... 功能/模块/组件/测试
  /[开发创建构建]+.*(?:功能|模块|组件|特性|测试|工作流|集成|流水线|CI)/,
  // Chinese: 重构/优化/改进/完善 ... 模块/功能/代码
  /[重构优化改进完善]+.*(?:模块|功能|代码|结构|设计|项目)/,
];

const STRATEGY_PATTERNS = [
  // CJK by-feature first (before by-perspective)
  {
    strategy: STRATEGY.BY_FEATURE,
    patterns: CJK_FEATURE_PATTERNS,
  },
  {
    strategy: STRATEGY.BY_PERSPECTIVE,
    patterns: [
      // Multiple quality dimensions listed (e.g. "security, performance, ...and accessibility")
      /\b(?:security|performance|accessibility|maintainability|reliability|testing|code\s+structure|documentation|error\s+handling)\b.+\b(?:security|performance|accessibility|maintainability|reliability|testing|code\s+structure|documentation|error\s+handling)\b/i,
      // Chinese: multiple perspectives with Chinese separators
      /[安全性能可靠可维护架构测试用户体验可访问性]+[、，,].*[安全性能可靠可维护架构测试用户体验可访问性]+/,
      // Chinese: 审查/审计/评估 ... 质量/安全/性能
      /[审查审计评估分析]+.*[质量安全性能架构可维护性可靠性]+/,
      // "review/audit/analyze/assess ... for quality/issues/problems"
      /\b(?:review|audit|analyze|assess)\b.*\b(?:for\s+)?(?:quality|issues|problems)\b/i,
      /\b(?:security\s+)?audit\b/i,
      /\bsecurity\s+review\b/i,
      /\b(?:review|analyze|assess)\s+(?:for|from)\s+(?:multiple\s+)?(?:perspectives?|angles?)\b/i,
      /\breview\s+(?:all\s+)?(?:the\s+)?[\w\s]*?\b(?:code(?:base)?s?|files)\b.*?(?:security|vulnerab|quality|performance)\b/i,
      /\bresearch\b/i,
      /\b(?:evaluate|assess)\s+(?:the\s+)?(?:system|architecture|design)\b/i,
      /\bthreat\s+model/i,
      /\bcode\s+review\b.*\b(?:quality|security|performance)\b/i,
      /\banaly(sis|ze)\s+(?:of\s+)?(?:the\s+)?(?:system|architecture)\b/i,
      /\bcompare\s+(?:and\s+)?contrast\b/i,
      // Chinese: 同时/并行/多 视角/维度/方面
      /[同时并行]+.*[视角维度方面]+/,
      // Chinese: 全面/完整 审查/检查/评估（限定更窄，避免误匹配优化类任务）
      /[全面完整系统]+(?:[审查检查评估分析]+.*?[质量安全性能漏洞]|(?:审查|审计|评估|分析)[全面完整系统]+)/,
    ],
  },
  {
    strategy: STRATEGY.BY_FEATURE,
    patterns: [
      /\b(?:add|implement|build|create|develop)\s+.+?\s+(?:to|for|in)\s+(?:the\s+)?\w+(?:\s+\w+)*(?:,\s*(?:and\s+)?\w+(?:\s+\w+)*)+/i,
      // Chinese: 添加/实现/构建/开发/增加 ... 到/给/在
      /[添加实现构建开发增加加入补充]+.*(?:功能模块组件页面|到|给|在)/,
      // Chinese: 开发/编写/创建 ... 功能/模块/组件
      /[开发编写创建]+.*(?:功能|模块|组件|特性|特性支持)/,
      /\b(?:add|implement|build|create|develop)\s+(?:support\s+)?(?:for\s+)?(?:the\s+)?feature/i,
      /\bfeature\b/i,
      /\bmodule\b.*\b(?:each|every|separate)\b/i,
      /\bcomponent\b/i,
      /\b(?:add|write)\s+(?:unit\s+)?tests?\s+for\b/i,
      // Chinese: 测试/编写测试
      /[测试]+(?:编写|添加|补充|覆盖)?/,
      /\b(?:bug\s*fix|fix\s+the)\b/i,
      // Chinese: 修复/修复bug
      /[修复解决]+(?:问题|bug|缺陷)?/,
      /\brefactor\s+(?:the\s+)?\w+\s+module\b/i,
      // Chinese: 重构/优化/改进
      /[重构优化改进完善]+(?:模块|功能|代码|结构|设计)?/,
      /\bseparate\s+(?:into|by)\s+(?:module|feature|component)\b/i,
      /\bper\s+(?:module|feature|component)\b/i,
      // Chinese: 每个/各个 ... 模块/功能
      /[每个各个]+.*(?:模块|功能|组件|页面|目录)/,
    ],
  },
  {
    strategy: STRATEGY.BY_DIRECTORY,
    patterns: [
      /\b(every|all|each)\s+file/i,
      /\b(?:all|every)\s+(?:the\s+)?files\s+in\b.*(?:\bdirectory\b|\bfolder\b|\bfile\s*path\b|\w+\/|\w+\\)/i,
      /\beach\s+(?:sub)?directory\b/i,
      /\breview\s+(?:all\s+)?(?:the\s+)?(?:code|files)\s+in\b.*(?:\bdirectory\b|\bfolder\b|\bfile\s*path\b|\w+\/|\w+\\)/i,
      /\blint\s+(?:all\s+)?(?:the\s+)?(?:files|code)\b/i,
      /\bformat\s+(?:all\s+)?(?:the\s+)?files\b/i,
      /\bdirectory\s+(?:by\s+directory|structure)\b/i,
      /\bdoc(?:ument)?\s+(?:all|every|each)\s+(?:file|module)/i,
      /\breorganize\s+(?:files|directories)\b/i,
      // Chinese: 所有/全部 文件/代码
      /[所有全部]+.*(?:文件|代码|目录)/,
      // Chinese: 整理/格式化 文件
      /[整理格式化规范化]+.*(?:文件|代码)/,
    ],
  },
  {
    strategy: STRATEGY.BY_PIPELINE,
    patterns: [
      /\bpipeline\b/i,
      /\b(?:step\s*(?:by\s*step|[\d.]))\b/i,
      /\bworkflow\b/i,
      /\bstages?\b/i,
      /\b(?:process|transform|migrate)\s+(?:the\s+)?(?:data|database)\b/i,
      /\bETL\b/i,
      /\bdata\s+(?:processing|pipeline)\b/i,
      /\b(?:build|compile|bundle|deploy)\s+(?:pipeline|process)\b/i,
      /\bsequential\b/i,
      // Chinese: 流水线/工作流/阶段
      /[流水线工作流阶段步骤流程]+/,
      // Chinese: 迁移/处理/构建/部署 流程
      /[迁移处理构建编译部署]+.*(?:流程|步骤|阶段)/,
    ],
  },
];

// ── Explicit item extraction ─────────────────────────────────────────────────

/**
 * Try to extract explicitly listed items from the task description.
 * Handles patterns like:
 *   - "refactor the auth, billing, and profile modules"
 *   - "fix bugs in src/api/, src/components/, src/utils/"
 *   - "review: security, performance, accessibility"
 *   - "1) setup db  2) write api  3) build UI"
 */
function extractExplicitItems(text) {
  // Numbered list: 1) item  2) item  3) item  or 1. item  2. item
  const numbered = text.match(/(?:\d[).]\s*)([^,;\n]+?)(?=\s*(?:\d[).]|\s*$))/g);
  if (numbered && numbered.length >= 2) {
    return numbered.map(s => s.replace(/^\d[).]\s*/, '').trim()).filter(Boolean);
  }

  // Bullet list: - item, * item
  const bullets = text.match(/(?:^|\n)\s*[-*]\s+([^\n]+)/g);
  if (bullets && bullets.length >= 2) {
    return bullets.map(s => s.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean);
  }

  // Colon-separated list: "quality: check security, performance, ..."
  // Handles "label: item1, item2, ..., itemN" patterns.
  // Supports both English (:) and Chinese (：) colons.
  // Runs before oxford comma to avoid greedy match on label-prefix words.
  const colonList = text.match(/[:：]\s*(?:check\s+)?([^.:：;；]+(?:[,，]\s*(?:and\s+)?[^,:：;；]+)+)/i);
  if (colonList) {
    const parts = colonList[1]
      .split(/\s*[,，]\s*(?:and\s+)?\s*/)
      .map(s => s.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      return parts;
    }
  }

  // Chinese enumeration separator (、): "功能A、功能B、功能C"
  // Handles "item1、item2、item3" patterns.
  const cjkEnum = text.match(/(?:在|给|到|为|对|关于|包括)?[^:：,，;；\n]+?(?=[、][^、\n]+[、])/);
  if (cjkEnum) {
    // Extract the full segment containing 、 separators
    const segStart = cjkEnum.index;
    const remainder = text.slice(segStart);
    const fullSegment = remainder.match(/^([^:：;；\n]*?[、][^:：;；\n]+)/);
    if (fullSegment) {
      const parts = fullSegment[1]
        .split(/[、]/)
        .map(s => s.trim())
        .filter(Boolean);
      if (parts.length >= 2) {
        return parts;
      }
    }
  }

  // Comma/or-delimited (but not sentence commas — look for known structural cues):
  // "refactor the auth, billing, and profile modules"
  // "fix bugs in src/api/, src/components/, and src/utils/"
  // "add dark mode to settings, dashboard, and profile page"
  const oxford = text.match(/\b(?:in|for|of|from|to|across|modules?|director(?:y|ies)|files?|components?|features?)\s+(.+?)(?:\.|$)/i);
  if (oxford) {
    const parts = oxford[1]
      .split(/\s*(?:,\s*(?:and\s+)?|(?:,\s*)?and\s+)\s*/)
      .map(s => s.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      return parts;
    }
  }

  // Semicolon-separated
  if (text.includes(';') && text.split(';').length >= 3) {
    return text.split(';').map(s => s.trim()).filter(Boolean);
  }

  return null;
}

// ── Complexity scoring ───────────────────────────────────────────────────────

/**
 * Estimate task complexity on a 0–10 scale. Used to derive suggested N.
 */
function scoreComplexity(text, explicitItems) {
  let score = 1;

  // Length contributes
  if (text.length > 200) score += 1;
  if (text.length > 500) score += 1;
  if (text.length > 1000) score += 1;

  // Explicit items indicate granularity
  if (explicitItems) {
    score += Math.min(explicitItems.length, 4);
  }

  // Technical depth signals
  const depthSignals = [
    /\brefactor\b/i,
    /\bmigrat(?:e|ion)\b/i,
    /\bsecurity\b/i,
    /\bperformance\b/i,
    /\barchitecture\b/i,
    /\btest(?:s|ing)\b/i,
    /\bdatabase\b/i,
    /\bAPI\b/,
    /\bauth(?:entication)?\b/i,
    /\bdeploy(?:ment)?\b/i,
  ];
  score += depthSignals.filter(re => re.test(text)).length;

  // Cross-cutting concerns add complexity
  const crossCutting = [
    /\bi18n\b/i, /\binternationalization\b/i,
    /\ba11y\b/i, /\baccessibility\b/i,
    /\bresponsive\b/i,
    /\berror\s+handling\b/i,
    /\blogging\b/i,
    /\bmonitoring\b/i,
    /\bdocumentation\b/i,
  ];
  score += crossCutting.filter(re => re.test(text)).length * 0.5;

  return Math.min(Math.round(score), 10);
}

// ── Parallelism calculation ──────────────────────────────────────────────────

/**
 * Determine the optimal N (number of parallel subtasks).
 *
 * Guiding principles:
 * 1. If explicit items are detected, N = item count (capped).
 * 2. Otherwise, N scales with complexity score, bounded by diminishing returns.
 * 3. Never less than minParallelism, never more than maxConcurrentSessions.
 */
function calculateN(text, explicitItems, complexityScore, config) {
  const { maxConcurrentSessions, defaultParallelism, minParallelism } = config;

  if (explicitItems && explicitItems.length >= 2) {
    return Math.min(explicitItems.length, maxConcurrentSessions);
  }

  // Map complexity 0–10 to N 2–8 with diminishing returns
  // complexity 1-3 → N=2-3, 4-6 → N=4-5, 7-8 → N=6-7, 9-10 → N=8
  let n;
  if (complexityScore <= 2) n = minParallelism;
  else if (complexityScore <= 4) n = 3;
  else if (complexityScore <= 6) n = defaultParallelism;
  else if (complexityScore <= 8) n = 6;
  else n = maxConcurrentSessions;

  return Math.max(minParallelism, Math.min(n, maxConcurrentSessions));
}

// ── Public: analyzeTask ──────────────────────────────────────────────────────

/**
 * Analyze a task description and return its classification + suggested parallelism.
 *
 * @param {string} taskDescription - Natural language task description
 * @param {object} [options]
 * @param {number} [options.maxConcurrentSessions=8]
 * @param {number} [options.defaultParallelism=4]
 * @param {number} [options.minParallelism=2]
 * @returns {{ taskType: string, suggestedN: number, complexity: number, explicitItems: string[]|null }}
 */
export function analyzeTask(taskDescription, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const text = taskDescription.trim();

  // Determine strategy: first-match against pattern list
  let taskType = STRATEGY.BY_DIRECTORY; // fallback
  for (const entry of STRATEGY_PATTERNS) {
    if (entry.patterns.some(re => re.test(text))) {
      taskType = entry.strategy;
      break;
    }
  }

  const explicitItems = extractExplicitItems(text);
  const complexity = scoreComplexity(text, explicitItems);
  const suggestedN = calculateN(text, explicitItems, complexity, config);

  return { taskType, suggestedN, complexity, explicitItems };
}

// ── Decomposition strategies ─────────────────────────────────────────────────

/**
 * Partition work by filesystem path.
 * Best when the task involves operating on specific directories.
 */
function decomposeByDirectory(text, n, explicitItems) {
  if (explicitItems && explicitItems.length >= n) {
    return explicitItems.slice(0, n).map((item, i) => ({
      id: `subtask-${i + 1}`,
      description: `${item.trim().replace(/\.$/, '')}`,
      strategy: STRATEGY.BY_DIRECTORY,
      target: item.trim(),
      prompt: buildDirectoryPrompt(text, item.trim()),
    }));
  }

  // Fallback: generic directory-based decomposition
  return Array.from({ length: n }, (_, i) => ({
    id: `subtask-${i + 1}`,
    description: `Process partition ${i + 1} of the workspace`,
    strategy: STRATEGY.BY_DIRECTORY,
    target: `partition-${i + 1}`,
    prompt: `${text}\n\nFocus on partition ${i + 1} of ${n}. Work on your assigned files/directories only.`,
  }));
}

/**
 * Partition work by feature/module.
 */
function decomposeByFeature(text, n, explicitItems) {
  if (explicitItems && explicitItems.length >= 2) {
    const items = explicitItems.slice(0, n);
    return items.map((item, i) => ({
      id: `subtask-${i + 1}`,
      description: `${item.trim().replace(/\.$/, '')}`,
      strategy: STRATEGY.BY_FEATURE,
      target: item.trim(),
      prompt: buildFeaturePrompt(text, item.trim()),
    }));
  }

  return Array.from({ length: n }, (_, i) => ({
    id: `subtask-${i + 1}`,
    description: `Feature module ${i + 1}`,
    strategy: STRATEGY.BY_FEATURE,
    target: `module-${i + 1}`,
    prompt: `${text}\n\nWork on module ${i + 1} of ${n}.`,
  }));
}

/**
 * Assign different analysis perspectives to each agent.
 */
function decomposeByPerspective(text, n, explicitItems) {
  let perspectives;
  if (explicitItems && explicitItems.length >= 2) {
    // Create perspective objects from user-specified items
    perspectives = explicitItems.slice(0, n).map(item => ({
      name: item.trim().replace(/\.$/, ''),
      guidance: 'Analyze this aspect thoroughly.',
    }));
  } else {
    perspectives = selectPerspectives(text, n);
  }

  return perspectives.map((p, i) => ({
    id: `subtask-${i + 1}`,
    description: `Analyze from perspective: ${p.name}`,
    strategy: STRATEGY.BY_PERSPECTIVE,
    target: p.name,
    prompt: `${text}\n\nFocus exclusively on the ${p.name} perspective. ${p.guidance}`,
  }));
}

const PERSPECTIVE_POOL = [
  { name: 'security', guidance: 'Look for vulnerabilities, injection risks, broken auth, data exposure.' },
  { name: 'performance', guidance: 'Identify bottlenecks, unnecessary allocations, slow queries, render blocking.' },
  { name: 'maintainability', guidance: 'Assess code clarity, coupling, duplication, and adherence to patterns.' },
  { name: 'accessibility', guidance: 'Check ARIA, keyboard nav, screen-reader compatibility, color contrast.' },
  { name: 'reliability', guidance: 'Examine error handling, edge cases, race conditions, and fault tolerance.' },
  { name: 'testing', guidance: 'Evaluate test coverage, test quality, mocking strategy, and CI integration.' },
  { name: 'architecture', guidance: 'Review component boundaries, data flow, dependency direction, and SOLID principles.' },
  { name: 'UX', guidance: 'Review user flows, error states, loading states, and interaction patterns.' },
];

function selectPerspectives(text, n) {
  // Prioritize perspectives that match keywords in the text
  const textLower = text.toLowerCase();
  const scored = PERSPECTIVE_POOL.map(p => ({
    ...p,
    score: textLower.includes(p.name) ? 2 : 1,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n);
}

/**
 * Pipeline stages: sequential but each stage is a self-contained unit.
 */
function decomposeByPipeline(text, n, explicitItems) {
  if (explicitItems && explicitItems.length >= 2) {
    const items = explicitItems.slice(0, n);
    return items.map((item, i) => ({
      id: `subtask-${i + 1}`,
      description: `Stage ${i + 1}: ${item.trim().replace(/\.$/, '')}`,
      strategy: STRATEGY.BY_PIPELINE,
      target: `stage-${i + 1}`,
      order: i,
      prompt: buildPipelinePrompt(text, item.trim(), i + 1, items.length),
    }));
  }

  return Array.from({ length: n }, (_, i) => ({
    id: `subtask-${i + 1}`,
    description: `Pipeline stage ${i + 1}`,
    strategy: STRATEGY.BY_PIPELINE,
    target: `stage-${i + 1}`,
    order: i,
    prompt: `${text}\n\nExecute stage ${i + 1} of ${n} in the pipeline.`,
  }));
}

// ── Prompt builders ──────────────────────────────────────────────────────────

function buildDirectoryPrompt(original, target) {
  return [
    original,
    '',
    `---`,
    `Your assigned scope: ${target}`,
    `Only modify or analyze files within ${target}.`,
    `Report findings with file paths relative to ${target}.`,
  ].join('\n');
}

function buildFeaturePrompt(original, feature) {
  return [
    original,
    '',
    `---`,
    `Your assigned feature: ${feature}`,
    `Focus exclusively on this feature area. Note any cross-cutting concerns but do not implement them.`,
  ].join('\n');
}

function buildPipelinePrompt(original, stage, stageNum, total) {
  return [
    original,
    '',
    `---`,
    `Stage ${stageNum} of ${total}: ${stage}`,
    `Complete only this stage. Your output will feed into downstream stages.`,
    `Produce clear, well-structured output that the next stage can consume.`,
  ].join('\n');
}

// ── Public: decompose ────────────────────────────────────────────────────────

const DECOMPOSERS = {
  [STRATEGY.BY_DIRECTORY]:   decomposeByDirectory,
  [STRATEGY.BY_FEATURE]:     decomposeByFeature,
  [STRATEGY.BY_PERSPECTIVE]: decomposeByPerspective,
  [STRATEGY.BY_PIPELINE]:    decomposeByPipeline,
};

/**
 * Decompose a task into N independent subtask plans.
 *
 * @param {string} taskDescription - Natural language task description
 * @param {number} n - Number of subtasks to produce
 * @param {object} [options]
 * @param {string} [options.taskType] - Force a specific strategy. Auto-detected if omitted.
 * @param {string[]|null} [options.explicitItems] - Pre-extracted items (from analyzeTask)
 * @returns {Array<{id: string, description: string, strategy: string, target: string, prompt: string}>}
 */
export function decompose(taskDescription, n, options = {}) {
  const { taskType, explicitItems } = options;

  let strategy = taskType;
  if (!strategy || !DECOMPOSERS[strategy]) {
    // Re-analyze if not provided
    const analysis = analyzeTask(taskDescription);
    strategy = analysis.taskType;
  }

  const items = explicitItems || extractExplicitItems(taskDescription);
  const decomposer = DECOMPOSERS[strategy];
  const subtasks = decomposer(taskDescription, n, items);

  // Ensure each subtask has the required fields
  return subtasks.map((st, i) => ({
    id: st.id || `subtask-${i + 1}`,
    description: st.description || `Subtask ${i + 1}`,
    strategy: st.strategy || strategy,
    target: st.target || `item-${i + 1}`,
    prompt: st.prompt || taskDescription,
    ...(st.order !== undefined ? { order: st.order } : {}),
  }));
}

/**
 * Full analysis + decomposition in one call.
 *
 * @param {string} taskDescription
 * @param {object} [options] - Config options passed through to analyzeTask
 * @returns {{ analysis: object, subtasks: object[] }}
 */
export function breakdown(taskDescription, options = {}) {
  const analysis = analyzeTask(taskDescription, options);
  const subtasks = decompose(taskDescription, analysis.suggestedN, {
    taskType: analysis.taskType,
    explicitItems: analysis.explicitItems,
  });

  return { analysis, subtasks };
}
