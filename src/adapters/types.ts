import type { AgentConfig } from '../core/types.js';

/**
 * An adapter drives one coding-agent runtime, headlessly, inside a prepared
 * workspace (a git worktree on the task's branch). It gets a single composed
 * prompt and must come back with a proposal-shaped result. Adapters never
 * touch .troupe/ themselves - the runner owns state; adapters own the agent.
 */
export interface AdapterRunInput {
  /** Absolute path of the workspace the agent may modify. */
  workspaceDir: string;
  /** Fully composed prompt (task brief + proposal instructions). */
  prompt: string;
  taskId: string;
  config: AgentConfig;
  timeoutMs: number;
  /** Called with raw output chunks for run-log streaming. */
  onOutput?: (chunk: string) => void;
}

export interface AdapterResult {
  ok: boolean;
  /** One-line summary of what was done (falls back to first output line). */
  summary: string;
  /** Full output/report from the agent, markdown-friendly. */
  output: string;
  error?: string;
  /** Adapter-specific metadata worth auditing (model, cost, duration). */
  meta?: Record<string, unknown>;
}

export interface Adapter {
  name: string;
  /** Quick environment check: null when usable, otherwise a human-readable reason. */
  available(): Promise<string | null>;
  run(input: AdapterRunInput): Promise<AdapterResult>;
}
