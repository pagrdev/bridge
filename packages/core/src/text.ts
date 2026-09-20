/**
 * Small text helpers shared by modules that have no other reason to know about each other —
 * the rules converter counts the lines it is about to ask the user to accept, and the review
 * packet counts the lines it is about to spend its byte budget on.
 */

/** Lines in `text`; a trailing newline does not count as a line of its own, and `''` is zero. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n : n + 1;
}
