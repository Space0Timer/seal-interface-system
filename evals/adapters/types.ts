// The contract between the agent-independent runner and an agent adapter.
// The runner owns workspace isolation, fixtures, rendering and results; an
// adapter owns skill placement, session launch and invocation, and proves
// its session stayed isolated.

/** A file placed just outside the workspace. Its token must never show up in a session. */
export interface Canary {
  /** Absolute path of the canary file. */
  file: string;
  /** Unique text inside it. */
  token: string;
}

export interface GenerateOptions {
  /** Exact model ID for live adapters. */
  model?: string | undefined;
  /** Reasoning effort (low, medium, high, xhigh, max). Unset: the agent's default for the model. */
  effort?: string | undefined;
  /** Folder in the run's results where the adapter writes its logs. */
  logDir: string;
  /**
   * Private folder outside the workspace for the adapter's own state (a
   * fresh home or config directory). The runner deletes it with the workspace.
   */
  stateDir: string;
  canary: Canary;
  /** Absolute paths the session must never see or mention: this repo, the results. */
  forbiddenPaths: string[];
  /**
   * Files inside the forbidden paths that are harmless to read, so an
   * adapter can try reading them to prove it can't: runner-made markers,
   * each with a token that must never come back, and files known to hold
   * nothing sensitive, such as the repo's own package.json. An adapter must
   * never try to read any other file in a forbidden path, since a failed
   * check would already have its contents in the logs.
   */
  readProbes: ReadProbe[];
  /** The condition's skill, if any: its name and folder relative to the workspace. */
  skill?: { name: string; dir: string } | undefined;
  /** Spending cap for live adapters, in US dollars. */
  maxBudgetUsd?: number | undefined;
  timeoutMs: number;
  /** Aborted when the run is stopped. The adapter must end its session. */
  signal?: AbortSignal | undefined;
}

export interface ReadProbe {
  file: string;
  /** For a marker: its unique text. */
  token?: string | undefined;
}

/** One isolation check. A run is invalid if any check fails. */
export interface IsolationCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface Usage {
  costUsd?: number | undefined;
  turns?: number | undefined;
  durationMs?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheCreationTokens?: number | undefined;
}

export interface GenerateResult {
  /** The session ran to completion. False on a crash, timeout, budget stop or error result. */
  ok: boolean;
  error?: string | undefined;
  /** The model the session reported using. */
  model?: string | undefined;
  /** Log files written, relative to logDir. */
  logs: string[];
  isolation: IsolationCheck[];
  usage?: Usage | undefined;
  /** What the adapter applied to isolate the session (flags, settings, env names), for the record. No secrets. */
  settings?: Record<string, unknown> | undefined;
}

export interface Adapter {
  name: string;
  /** True if the adapter calls a model, which costs money. */
  live: boolean;
  /** Where this agent discovers a project skill, relative to the workspace. */
  skillDir(name: string): string;
  /** The agent's version, if it has one. */
  version(): string | undefined;
  /** Throws if the adapter can't run here (agent missing, no credentials). Called before anything is created. */
  check?(): void;
  generate(workspace: string, prompt: string, options: GenerateOptions): Promise<GenerateResult>;
}
