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
// - Every forbidden path (each repo checkout, the results, ~/.claude) is
//   denied to the file tools and to the sandbox wherever it is: a checkout
//   outside the home folder is no less forbidden. Claude Code shows the model
//   its sandbox settings, so the deny names a folder that covers the path
//   without naming it (see sandboxCover).
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
  /**
   * Claude Code's shared temp folder (/tmp/claude-<uid>). It's hidden from
   * reads, but the session's shell still writes its working-directory file
   * there, so no cover may take in the folder around it.
   */
  agentTemp: string;
  /** Paths the session must never reach (each repo checkout, the results, ~/.claude), wherever they are. */
  forbidden: string[];
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

const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/**
 * The folders to deny so every forbidden path is hidden without being
 * named. Claude Code puts its sandbox settings, Read deny rules included, in
 * the system prompt, so denying a repo checkout by name would tell the model
 * where it is and what it's called. A forbidden path is covered by the
 * hidden root that holds it, else by its highest ancestor that holds
 * nothing the session needs: for a checkout in /private/tmp/review/repo,
 * that's /private/tmp. Only a path with no such ancestor is denied by name,
 * and the probe's first-request check then fails the run.
 */
export function sandboxCover(forbidden: string[], hiddenRoots: string[], needed: string[]): string[] {
  const covers: string[] = [];
  for (const path of forbidden) {
    const covering = [...hiddenRoots, ...covers].find((root) => inside(path, root));
    if (covering) {
      covers.push(covering);
      continue;
    }
    const parts = path.split('/').filter(Boolean);
    const ancestors = parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`);
    covers.push(ancestors.find((dir) => !needed.some((n) => inside(n, dir))) ?? path);
  }
  return [...new Set(covers)];
}

const needed = (input: InvocationInput) => [input.workspace, input.stateDir, input.agentTemp, ...input.toolRoots];

/** What this session's settings deny to hide its forbidden paths. */
export function coverFor(input: InvocationInput): string[] {
  return sandboxCover(input.forbidden, input.hiddenRoots, needed(input));
}

export function buildSettings(input: InvocationInput): Record<string, unknown> {
  const { scratch, canaryDir, hiddenRoots, workspace, toolRoots } = input;
  const cover = coverFor(input);
  // A permission rule can't re-allow a folder inside the one it denies, as the sandbox's allowRead does. So the
  // file tools get explicit rules only for covers that hold nothing the session needs; the hidden roots that hold
  // the workspace or the toolchain are kept from them by blockReadsOutsideWorkingDirectories.
  const fileToolCover = cover.filter((dir) => !needed(input).some((n) => inside(n, dir)));
  return {
    permissions: {
      defaultMode: 'dontAsk',
      allow: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Skill'],
      // "//" starts an absolute path in a permission rule. Read rules also cover Glob and Grep.
      deny: ['WebFetch', 'WebSearch', 'Agent', 'NotebookEdit', ...[canaryDir, ...fileToolCover].flatMap((dir) => [`Read(/${dir}/**)`, `Edit(/${dir}/**)`])],
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: [...new Set([...hiddenRoots, ...cover, scratch])],
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
