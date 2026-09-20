/**
 * Risk hints and path containment live in `@pagr/bridge-core` (`core/src/heuristics.ts`), so the
 * adapters, the device floor and `pagr doctor` all judge an action by exactly the same rules.
 * Re-exported here because both adapter packages built their own copy first.
 */
export {
  absolutePathsIn,
  clip,
  type Hints,
  hintsForCommand,
  hintsForFiles,
  isInside,
  realpathNearest,
  relativizePaths,
} from '@pagr/bridge-core';

/**
 * Attachments, as a line the model can act on.
 *
 * Paths rather than bytes: the images are already on this Mac, the agent can open a file, and
 * inlining them would put them through the model's context twice.
 */
export const withImages = (instruction: string, images: string[]): string =>
  images.length
    ? `${images.map((p) => `See screenshot at ${p}`).join('\n')}\n\n${instruction}`
    : instruction;
