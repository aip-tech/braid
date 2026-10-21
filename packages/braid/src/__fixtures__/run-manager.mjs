// Runs runManager in its own process (the way `braid start --foreground` does), so a test can
// signal or SIGKILL the manager itself without taking the test runner down with it. Run with the
// tsx loader (sourceExecArgv), which resolves this .ts import.
import { runManager } from "../manager.ts";

const [configsJson, pidfilePath] = process.argv.slice(2);
process.exitCode = await runManager(JSON.parse(configsJson), pidfilePath);
