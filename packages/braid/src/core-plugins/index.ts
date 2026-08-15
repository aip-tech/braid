import { loggerPlugin } from "./logger.js";
import { statusPlugin } from "./status.js";

/**
 * Every plugin manager.ts registers unconditionally, regardless of a given
 * config's `plugins` array. Not exported from the package's public index.ts.
 */
export const CORE_PLUGINS = [loggerPlugin, statusPlugin];
