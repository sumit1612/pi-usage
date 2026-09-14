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
}

export interface AggregateOptions {
  dir?: string;
  all?: boolean;
  since?: number;
  model?: string | null;
  provider?: string | null;
}

export interface ModelBucket {
  provider: string | null;
  model: string | null;
  usage: Usage;
}

export interface SessionBucket {
  file: string;
  kind: string;
  name: string | null;
  cwd: string | null;
  started: string | null;
  usage: Usage;
}

export interface AggregateResult {
  totals: Usage;
  byModel: Map<string, ModelBucket>;
  byDay: Map<string, Usage>;
  bySession: Map<string, SessionBucket>;
  sessionsMain: number;
  sessionsSubagent: number;
}

export interface SessionData {
  name: string | null;
  kind: string;
  cwd: string | null;
  started: string | null;
  usage: Usage;
}

export interface UsageData {
  totals: Usage;
  byModel: Record<string, Usage>;
  byDay: Record<string, Usage>;
  bySession: Record<string, SessionData>;
  sessionCounts: { main: number; subagent: number };
}

export const DEFAULT_SESSION_DIR: string;

export function aggregate(opts?: AggregateOptions): AggregateResult;
export function toData(agg: AggregateResult): UsageData;
