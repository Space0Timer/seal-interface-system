// The generator prompt: one neutral text, identical for every condition.
// Only the brief's filename is filled in.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROMPT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompt.md');

export function renderPrompt(brief: string): string {
  const template = readFileSync(PROMPT_FILE, 'utf8');
  if (!template.includes('{{brief}}')) throw new Error('prompt.md must name the brief with {{brief}}');
  return template.replaceAll('{{brief}}', `${brief}.md`).trim();
}
