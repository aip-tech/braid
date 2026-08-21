export type ProcessStatus = {
	name: string;
	pid: number | undefined;
	alive: boolean;
	startedAt: string;
};

export function formatStarted(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export async function postAction(
	action: "stop" | "restart",
	name: string,
): Promise<{ ok: boolean; message: string }> {
	const res = await fetch(
		`/api/processes/${action}?name=${encodeURIComponent(name)}`,
		{ method: "POST" },
	);
	const text = await res.text();
	return { ok: res.ok, message: text };
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
