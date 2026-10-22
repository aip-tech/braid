/**
 * Environment variables braid uses only to talk to its own processes - the daemon flag, a worker's
 * own config, the timestamps setting - never meant for anything they in turn spawn. A fixed list
 * rather than a `BRAID_` prefix, so a user's own `BRAID_*` variables still pass through untouched.
 * `BRAID_DAEMON_INPUT` is how braid <0.10 passed the daemon its whole config (every process's
 * `env` included); it's listed so nothing spawned from such a daemon inherits it either.
 */
export const INTERNAL_ENV_KEYS = [
	"BRAID_DAEMON",
	"BRAID_DAEMON_INPUT",
	"BRAID_CONFIG",
	"BRAID_LOG_TIMESTAMPS",
] as const;

/** `base` overlaid with `extra`, minus braid's internal variables - the environment for anything
 *  braid spawns on a user's behalf (an app, a hook). */
export function childEnv(
	base: NodeJS.ProcessEnv,
	extra?: Record<string, string>,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base, ...extra };
	for (const key of INTERNAL_ENV_KEYS) delete env[key];
	return env;
}
