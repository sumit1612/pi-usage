export interface Usage {
  calls: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    context: number;
    total: number;
  };
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  /** cacheRead / (input + cacheRead + cacheWrite), 0..1 */
  cacheHitRate: number;
  /** reasoning / total, 0..1 */
  reasoningRatio: number;
  /** cost.total * 1e6 / tokens.total (dollars per 1M tokens) */
  costPer1M: number;
  /** tokens.total / calls */
  avgTokensPerCall: number;
}

export type GroupKey = 'day' | 'week' | 'month';

export interface AggregateOptions {
  dir?: string;
  all?: boolean;
  since?: number;
  model?: string | null;
  provider?: string | null;
  cwd?: string | null;
  group?: GroupKey;
}

export interface ModelBucket {
  provider: string | null;
  model: string | null;
  usage: Usage;
}

export interface SessionBucket {
  file: string;
  kind: 'main' | 'fork' | 'subagent';
  name: string | null;
  cwd: string | null;
  started: string | null;
  parentSession?: string | null;
  agent: string | null;
  usage: Usage;
}

export interface AggregateResult {
  totals: Usage;
  byModel: Map<string, ModelBucket>;
  byProvider: Map<string, Usage>;
  byAgent: Map<string, Usage>;
  byDay: Map<string, Usage>;
  bySession: Map<string, SessionBucket>;
  modelSwitches: number;
  apiBreakdown: Map<string, { calls: number; tokens: number }>;
  sessionsMain: number;
  sessionsFork: number;
  sessionsSubagent: number;
}

export interface SessionData {
  name: string | null;
  kind: 'main' | 'fork' | 'subagent';
  cwd: string | null;
  started: string | null;
  agent: string | null;
  usage: Usage;
}

export interface UsageData {
  totals: Usage;
  byModel: Record<string, Usage>;
  byProvider: Record<string, Usage>;
  byAgent: Record<string, Usage>;
  byDay: Record<string, Usage>;
  bySession: Record<string, SessionData>;
  modelSwitches: number;
  apiBreakdown: Record<string, { calls: number; tokens: number }>;
  sessionCounts: { main: number; fork: number; subagent: number };
}

export const DEFAULT_SESSION_DIR: string;

export function aggregate(opts?: AggregateOptions): AggregateResult;
export function toData(agg: AggregateResult): UsageData;
export function normalizeUsage(raw: unknown): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};
