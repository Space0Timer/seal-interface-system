// What must never reach a generator: words that would tell it about the
// experiment around it, and the owner's reference copy, which lives only in
// the skill (principles P9). The starter's tests scan every workspace with
// these, and the runner scans its prompt and each workspace before a run.
//
// This file is never copied into a workspace (see TEMPLATE_FILES and
// TOOL_SOURCES in materialize.ts).

/** Words that would tell a generator about the experiment around it. */
export const EVAL_WORDS =
  /\bevals?\b|\bconditions?\b|\brubric|\bgenerators?\b|\bowner\b|SKILL\.md|principles\.md|ban-list|conformance|reviewer|design system|generated workspaces?|@ds\/|keep comments neutral|\bharness\b/i;

/** The owner's reference copy (principles P9). Only the skill may contain it. */
export const OWNER_COPY = [
  'No assets yet',
  'Upload files to add them to your library',
  'Try a different search',
  'Upload failed because the connection was interrupted',
  'Choose another file',
  'This file exceeds the 100 MB size limit',
];

/** Why a text would leak the eval or the owner's copy, or null if it wouldn't. */
export function leakIn(text: string, { ownerCopy = true }: { ownerCopy?: boolean } = {}): string | null {
  const word = EVAL_WORDS.exec(text);
  if (word) return `mentions "${word[0]}"`;
  if (ownerCopy) {
    const phrase = OWNER_COPY.find((p) => text.includes(p));
    if (phrase) return `contains the owner's copy "${phrase}"`;
  }
  return null;
}
