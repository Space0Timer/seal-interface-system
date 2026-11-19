// The experiment's conditions. A condition decides only what design guidance
// the generator's workspace gets; the prompt, starter, brief, fixtures,
// model and tools stay the same.

export interface Condition {
  name: string;
  /** Guidance installed as a project skill, copied from this repo. None for plain. */
  skill?: { name: string; from: string } | undefined;
  /** Whether implementation conformance (token lint) applies. */
  tokenLint: boolean;
}

export const CONDITIONS: Record<string, Condition> = {
  plain: { name: 'plain', tokenLint: false },
  // The hook for the my-skill condition: the skill lands where the adapter's
  // agent discovers project skills (for Claude Code, .claude/skills/design-system).
  'my-skill': { name: 'my-skill', skill: { name: 'design-system', from: 'core/design-system' }, tokenLint: true },
};

export function conditionNamed(name: string): Condition {
  const condition = CONDITIONS[name];
  if (!condition) throw new Error(`unknown condition "${name}"; known: ${Object.keys(CONDITIONS).join(', ')}`);
  return condition;
}
