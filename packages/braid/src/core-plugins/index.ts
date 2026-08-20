import { loggerPlugin } from "./logger.js";
import { processesPlugin } from "./processes.js";
import { statusPlugin } from "./status.js";

export const CORE_PLUGINS = [loggerPlugin, statusPlugin, processesPlugin];
