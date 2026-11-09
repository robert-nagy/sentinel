/**
 * Deterministic duplicate detection by title. The agent lists candidates with its own
 * tracker tools (or the local tracker does); sentinel ranks them (ADR-0005).
 */

function words(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1),
  );
}

/** Jaccard similarity of the word sets of two titles, 0–1. */
export function titleSimilarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export const DUPLICATE_THRESHOLD = 0.5;

/** Candidates whose title is similar enough to `title`, most similar first. */
export function rankDuplicates<T extends { readonly title: string }>(
  title: string,
  candidates: readonly T[],
): T[] {
  return candidates
    .map((issue) => ({ issue, score: titleSimilarity(title, issue.title) }))
    .filter(({ score }) => score >= DUPLICATE_THRESHOLD)
    .sort((x, y) => y.score - x.score)
    .map(({ issue }) => issue);
}
