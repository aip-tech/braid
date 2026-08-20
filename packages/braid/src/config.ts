import type { BraidConfig } from "./types.js";

export const DEFAULT_LOG_MAX_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Type-checks a config's default export and fills in defaults that don't depend on runtime
 * context. `logs.dir` and `ProcessConfig.cwd` aren't filled in here - they resolve relative to
 * wherever the CLI is invoked from, which isn't known yet at this point.
 */
export function defineConfig(config: BraidConfig): BraidConfig {
	return {
		...config,
		logs: {
			...config.logs,
			maxSizeBytes: config.logs?.maxSizeBytes ?? DEFAULT_LOG_MAX_SIZE_BYTES,
			timestamps: config.logs?.timestamps ?? false,
		},
	};
}
