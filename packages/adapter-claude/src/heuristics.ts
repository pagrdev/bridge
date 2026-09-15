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
