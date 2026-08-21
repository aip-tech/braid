// pidusage ships no bundled types, and @types/pidusage is stuck at 2.0.5 (pre-v4) - this covers
// only the one calling convention actually used here (an array of pids, always returning a
// Record keyed by pid), confirmed against the real 4.0.1 source rather than guessed.
declare module "pidusage" {
	type Stat = {
		cpu: number;
		memory: number;
	};

	export default function pidusage(
		pids: number[],
	): Promise<Record<number, Stat>>;
}
