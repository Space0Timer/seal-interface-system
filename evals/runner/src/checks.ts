// Isolation checks the runner makes for every adapter, before and after a
// session: what reaches the generator (prompt, workspace, paths) carries no
// word about the eval, no owner copy, and no path into this repo.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IsolationCheck } from '../../adapters/types.ts';
import { leakIn } from '../../starter/src/leaks.ts';
import { isInside } from '../../starter/src/materialize.ts';
import { walk } from './files.ts';

const TEXT = /\.(md|ts|tsx|js|jsx|mjs|cjs|json|html|css|yaml|yml|txt)$/;

/** Folders a workspace scan skips: dependencies, and the binary upload files. */
export const SCAN_SKIP = { skipAnywhere: ['node_modules', '.git'], skipPaths: ['upload-files', 'replacement-files'] };

export interface ScanOptions {
  /** The condition's guidance folder (relative), which may name the eval's design guidance by design. */
  guidanceDir?: string | undefined;
  forbiddenPaths: string[];
}

/** Every text file in the workspace (except the guidance) is free of eval words, owner copy and forbidden paths. */
export function scanWorkspace(workspace: string, { guidanceDir, forbiddenPaths }: ScanOptions): IsolationCheck {
  const problems: string[] = [];
  const files = walk(workspace, { ...SCAN_SKIP, skipPaths: [...SCAN_SKIP.skipPaths, ...(guidanceDir ? [guidanceDir] : [])] });
  for (const rel of files.filter((f) => TEXT.test(f))) {
    const text = readFileSync(join(workspace, rel), 'utf8');
    const leak = leakIn(text);
    if (leak) problems.push(`${rel} ${leak}`);
    const path = forbiddenPaths.find((p) => text.includes(p));
    if (path) problems.push(`${rel} mentions ${path}`);
  }
  return {
    id: 'runner.workspace-neutral',
    ok: problems.length === 0,
    detail: problems.length ? problems.join('; ') : `${files.length} workspace files carry no eval words, owner copy or repo paths`,
  };
}

export function checkPrompt(prompt: string, forbiddenPaths: string[]): IsolationCheck {
  const leak = leakIn(prompt);
  const path = forbiddenPaths.find((p) => prompt.includes(p));
  const problem = leak ?? (path ? `mentions ${path}` : null);
  return { id: 'runner.prompt-neutral', ok: !problem, detail: problem ? `the prompt ${problem}` : 'the prompt carries no eval words, owner copy or repo paths' };
}

/** The workspace, and every folder the session could be told about, is outside the forbidden paths. */
export function checkOutside(workspace: string, forbiddenPaths: string[]): IsolationCheck {
  const inside = forbiddenPaths.filter((p) => isInside(workspace, p) || isInside(p, workspace));
  return {
    id: 'runner.workspace-outside-repo',
    ok: inside.length === 0,
    detail: inside.length ? `the workspace ${workspace} overlaps ${inside.join(', ')}` : `the workspace ${workspace} is outside the repo and the results`,
  };
}

/** The workspace path itself (which the session sees as its working directory) names nothing about the eval. */
export function checkWorkspacePath(workspace: string): IsolationCheck {
  const leak = leakIn(workspace, { ownerCopy: false });
  return { id: 'runner.workspace-path-neutral', ok: !leak, detail: leak ? `the workspace path ${leak}` : `the workspace path ${workspace} is neutral` };
}
