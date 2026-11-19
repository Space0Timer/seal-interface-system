// Builds the exact Claude Code command for one isolated session: flags,
// inline settings and a minimal environment. Pure, so tests can check that
// nothing in it points at the repo or names the eval.
//
// Isolation, layer by layer:
// - A fresh HOME and CLAUDE_CONFIG_DIR inside the run's private state folder,
//   so the owner's ~/.claude (CLAUDE.md, memory, skills, plugins, hooks,
//   settings, credentials) and ~/.claude.json (MCP servers) are never found.
// - --setting-sources project: only the workspace's own .claude/ (project
//   skills, for conditions that have one). CLAUDE.md loading and auto memory
//   are off in every condition.
// - --strict-mcp-config with no servers, claude.ai connectors off.
// - --tools: a fixed list. No web tools, no subagents.
// - dontAsk mode with explicit allow rules: nothing can prompt; anything not
//   allowed is denied.
// - The file tools are confined to the workspace; Bash runs in the OS
//   sandbox, which can't read the owner's home, the system temp folder (with
//   the canary and Claude Code's shared temp folder, which holds other
//   sessions' files), can't write outside the workspace, and has no network
//   except binding local ports.
// - Bundled skills and built-in plugins are off, so a plain session lists
//   no skill the model can use.
// - The environment is built from scratch: no inherited variable can carry
//   the repo path into the session.
//
// Some of these switches (CLAUDE_CODE_TMPDIR, CLAUDE_CODE_DISABLE_BUNDLED_SKILLS,
// the built-in plugin names) aren't in the public docs. The probe session in
// index.ts proves on every run that they took effect.
import { join } from 'node:path';

/** The fixed tool list for every condition. Skill is included so a skill can load where one exists. */
export const TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Skill'];

export interface InvocationInput {
  workspace: string;
  /** The session's private state folder (fresh home, config, temp). */
  stateDir: string;
  /** The temp folder that holds the workspace, the canary and the state. */
  scratch: string;
  /** The canary's folder, just outside the workspace. */
  canaryDir: string;
  model: string;
  effort?: string | undefined;
  maxBudgetUsd?: number | undefined;
  /**
   * Never readable from the sandbox: the real home, the system temp folder,
   * and Claude Code's shared temp folder (/tmp/claude-<uid>), which holds
   * other sessions' files.
   */
  hiddenRoots: string[];
  /** Folders the sandbox must still read (the Node and pnpm installs, which may live under the real home). */
  toolRoots: string[];
  /** PATH entries for node and pnpm. */
  binDirs: string[];
  /** Auth for the session: the subscription token, or a stub key with a local base URL. */
  auth: { oauthToken: string } | { stubUrl: string };
  user: string;
  /** Variables node and pnpm need, such as where corepack keeps the pinned pnpm. */
  toolEnv?: Record<string, string> | undefined;
}

/**
 * Plugins built into Claude Code itself, turned off so a session loads no
 * plugin at all. A new built-in plugin shows up in the init event, which
 * fails the isolation check until it's added here.
 */
export const BUILTIN_PLUGINS = ['cc-plugin-agents-md@builtin', 'cc-plugin-privacy@builtin', 'cc-plugin-plugin-authoring@builtin'];

export interface Invocation {
  args: string[];
  env: Record<string, string>;
  settings: Record<string, unknown>;
}

export function sessionPaths(stateDir: string) {
  const home = join(stateDir, 'home');
  return { home, config: join(home, '.claude'), tmp: join(stateDir, 'tmp'), agentTmp: join(stateDir, 'agent-tmp') };
}

export function buildSettings(input: InvocationInput): Record<string, unknown> {
  const { workspace, scratch, canaryDir, hiddenRoots, toolRoots } = input;
  return {
    permissions: {
      defaultMode: 'dontAsk',
      allow: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Skill'],
      // "//" starts an absolute path in a permission rule.
      deny: ['WebFetch', 'WebSearch', 'Agent', 'NotebookEdit', `Read(/${canaryDir}/**)`, `Edit(/${canaryDir}/**)`],
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: [...hiddenRoots, scratch],
        allowRead: [workspace, input.stateDir, ...toolRoots],
        allowWrite: [input.stateDir],
      },
      network: { allowedDomains: [], allowLocalBinding: true },
    },
    enabledPlugins: Object.fromEntries(BUILTIN_PLUGINS.map((p) => [p, false])),
    autoMemoryEnabled: false,
    disableClaudeAiConnectors: true,
  };
}

export function buildEnv(input: InvocationInput): Record<string, string> {
  const { home, config, tmp, agentTmp } = sessionPaths(input.stateDir);
  const path = [...new Set([...input.binDirs, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  const auth: Record<string, string> =
    'oauthToken' in input.auth
      ? { CLAUDE_CODE_OAUTH_TOKEN: input.auth.oauthToken }
      : { ANTHROPIC_BASE_URL: input.auth.stubUrl, ANTHROPIC_API_KEY: 'stub-key-not-a-secret' };
  return {
    HOME: home,
    CLAUDE_CONFIG_DIR: config,
    TMPDIR: tmp,
    PATH: path,
    SHELL: '/bin/zsh',
    USER: input.user,
    LOGNAME: input.user,
    LANG: 'en_US.UTF-8',
    ...input.toolEnv,
    ...auth,
    // Claude Code's own scratch files go to the private state, not the shared temp folder.
    CLAUDE_CODE_TMPDIR: agentTmp,
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
  };
}

export function buildInvocation(input: InvocationInput): Invocation {
  const settings = buildSettings(input);
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    input.model,
    ...(input.effort ? ['--effort', input.effort] : []),
    '--tools',
    TOOLS.join(','),
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--settings',
    JSON.stringify(settings),
    '--no-session-persistence',
    ...(input.maxBudgetUsd ? ['--max-budget-usd', String(input.maxBudgetUsd)] : []),
  ];
  return { args, env: buildEnv(input), settings };
}

/** The command, environment and settings with the token redacted, for the record. */
export function redacted(invocation: Invocation): Record<string, unknown> {
  const env = Object.fromEntries(Object.entries(invocation.env).map(([k, v]) => [k, k === 'CLAUDE_CODE_OAUTH_TOKEN' ? '<redacted>' : v]));
  return { args: invocation.args, env, settings: invocation.settings };
}
