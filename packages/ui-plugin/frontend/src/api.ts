export type ProcessStatus = {
	name: string;
	pid: number | undefined;
	alive: boolean;
	/** Absent for a configured process that has never been started (`autoStart: false`). */
	startedAt?: string;
	/** Percent of one CPU core. Absent until the daemon's first sample, or while stopped. */
	cpu?: number;
	/** RSS in bytes. Absent until the daemon's first sample, or while stopped. */
	memory?: number;
	/** Total completed restarts since the daemon started - 0, not absent, for a process that
	 *  hasn't restarted. Absent entirely when talking to a daemon running braid <0.9.5, which
	 *  doesn't send this field at all. */
	restartCount?: number;
};

export function formatCpu(cpu: number): string {
	return `${cpu.toFixed(1)}%`;
}

export function formatMemory(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

export function formatUptime(startedAt: string): string {
	const totalSeconds = Math.max(
		0,
		Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
	);
	const days = Math.floor(totalSeconds / 86400);
	const hours = Math.floor((totalSeconds % 86400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

export type HistorySample = { cpu: number; memory: number };

// ~1 minute of history at the dashboard's poll cadence (2s) - enough for a sparkline to show a
// real trend without growing unbounded for a long-running dashboard tab.
const HISTORY_LENGTH = 30;

/**
 * Folds a fresh /api/status response into the rolling per-process cpu/memory history, capped at
 * HISTORY_LENGTH samples per process. Rebuilt from `data` alone (not `prev`'s own keys) - a name
 * no longer present in `data` at all (removed from config entirely) is dropped here rather than
 * kept forever, which is what let a long-running tab's history accumulate unboundedly across
 * process churn (e.g. an autoStart:false process added/removed over time). A name still present
 * but unsampled this tick (stopped, or mid-restart) keeps its existing history rather than being
 * evicted too.
 *
 * Exported standalone (pure, no component/hook dependency) so this can be unit-tested on its own.
 */
export function updateHistory(
	prev: Map<string, HistorySample[]>,
	data: ProcessStatus[],
): Map<string, HistorySample[]> {
	const next = new Map<string, HistorySample[]>();
	for (const process of data) {
		if (process.cpu === undefined || process.memory === undefined) {
			const existing = prev.get(process.name);
			if (existing) next.set(process.name, existing);
			continue;
		}
		const samples = prev.get(process.name) ?? [];
		next.set(
			process.name,
			[...samples, { cpu: process.cpu, memory: process.memory }].slice(
				-HISTORY_LENGTH,
			),
		);
	}
	return next;
}

export function formatStarted(iso: string | undefined): string {
	if (iso === undefined) return "-";
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export async function postAction(
	action: "stop" | "restart" | "start",
	name: string,
): Promise<{ ok: boolean; status: number; message: string }> {
	const res = await fetch(
		`/api/processes/${action}?name=${encodeURIComponent(name)}`,
		{ method: "POST" },
	);
	const text = await res.text();
	return { ok: res.ok, status: res.status, message: text };
}

/** Fetched once - the running daemon's own braid version can't change without a restart. */
export async function fetchBraidVersion(): Promise<string | undefined> {
	try {
		const res = await fetch("/api/ui/version");
		if (!res.ok) return undefined;
		const { braidVersion } = (await res.json()) as { braidVersion: string };
		return braidVersion;
	} catch {
		// Leave it blank - not worth a whole banner over a version label.
		return undefined;
	}
}
