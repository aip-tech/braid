import { describe, expect, it } from "vitest";
import { childEnv, INTERNAL_ENV_KEYS } from "./child-env.js";

describe("childEnv", () => {
	it("overlays extra on base and removes every internal braid variable, from either", () => {
		const base = {
			PATH: "/bin",
			BRAID_DAEMON: "1",
			BRAID_DAEMON_INPUT: "{...}",
			BRAID_CONFIG: "{...}",
			BRAID_LOG_TIMESTAMPS: "1",
			BRAID_USER_SETTING: "mine",
		};
		const env = childEnv(base, { PORT: "3000", BRAID_CONFIG: "sneaky" });
		expect(env).toEqual({
			PATH: "/bin",
			PORT: "3000",
			BRAID_USER_SETTING: "mine",
		});
		for (const key of INTERNAL_ENV_KEYS) expect(env).not.toHaveProperty(key);
		// The caller's own object is left alone.
		expect(base.BRAID_CONFIG).toBe("{...}");
	});

	it("works with no extra", () => {
		expect(childEnv({ A: "1", BRAID_DAEMON: "1" })).toEqual({ A: "1" });
	});
});
