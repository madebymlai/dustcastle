export {
  completeMarker,
  depsCacheDecision,
  installSuccessSentinel,
  populateCommand,
  restoreCommand,
  type DepsCacheCommandInput,
  type DepsCacheDecision,
  type DepsCachePopulate,
} from "./depsCache.js";
export { type AuthoredSourceReader, readWorktreeAuthoredSource } from "./authoredSource.js";
export { depsCacheKey } from "./depsCacheKey.js";
export { defaultDepsCacheDir, depsCachePool, type DepsCachePoolOptions } from "./depsCachePool.js";
