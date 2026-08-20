type ProcessStatus = {
	name: string;
	pid: number | undefined;
	alive: boolean;
	startedAt: string;
};

const POLL_INTERVAL_MS = 2000;

const tbody = document.querySelector("#processes tbody") as HTMLTableSectionElement;
const errorBanner = document.querySelector("#error") as HTMLParagraphElement;
const versionLabel = document.querySelector("#braid-version") as HTMLSpanElement;

// Fetched once - the running daemon's own braid version can't change without a restart.
async function loadBraidVersion(): Promise<void> {
	try {
		const res = await fetch("/api/ui/version");
		if (!res.ok) return;
		const { braidVersion } = (await res.json()) as { braidVersion: string };
		versionLabel.textContent = `v${braidVersion}`;
	} catch {
		// Leave it blank - not worth a whole banner over a version label.
	}
}

// Names with a stop/restart request currently in flight - their row's buttons stay disabled and
// a fast refresh runs right after, rather than waiting for the next poll tick.
const pending = new Set<string>();

function showBanner(message: string | undefined): void {
	errorBanner.textContent = message ?? "";
	errorBanner.hidden = !message;
}

async function postAction(
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

function formatStarted(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function renderRow(process: ProcessStatus, rowError: string | undefined): HTMLTableRowElement {
	const row = document.createElement("tr");
	const busy = pending.has(process.name);

	const nameCell = document.createElement("td");
	nameCell.textContent = process.name;
	if (rowError) {
		const errorLine = document.createElement("div");
		errorLine.className = "row-error";
		errorLine.textContent = rowError;
		nameCell.append(errorLine);
	}

	const pidCell = document.createElement("td");
	pidCell.textContent = process.pid !== undefined ? String(process.pid) : "-";

	const statusCell = document.createElement("td");
	statusCell.textContent = process.alive ? "running" : "stopped";
	statusCell.className = process.alive ? "status-running" : "status-stopped";

	const startedCell = document.createElement("td");
	startedCell.textContent = formatStarted(process.startedAt);

	const actionsCell = document.createElement("td");
	const stopButton = document.createElement("button");
	stopButton.textContent = busy ? "..." : "Stop";
	stopButton.disabled = busy || !process.alive;
	stopButton.addEventListener("click", () => void runAction("stop", process.name));

	const restartButton = document.createElement("button");
	restartButton.textContent = busy ? "..." : "Restart";
	restartButton.disabled = busy;
	restartButton.addEventListener("click", () => void runAction("restart", process.name));

	actionsCell.append(stopButton, restartButton);
	row.append(nameCell, pidCell, statusCell, startedCell, actionsCell);
	return row;
}

const rowErrors = new Map<string, string>();

async function refresh(): Promise<void> {
	let res: Response;
	try {
		res = await fetch("/api/status");
	} catch {
		showBanner("Lost connection to braid - is the daemon still running?");
		return;
	}
	if (res.status === 401) {
		showBanner("Session expired (the daemon may have restarted) - reload this page.");
		return;
	}
	if (!res.ok) {
		showBanner(`braid: ${res.status} ${await res.text()}`);
		return;
	}
	showBanner(undefined);

	const processes = (await res.json()) as ProcessStatus[];
	processes.sort((a, b) => a.name.localeCompare(b.name));

	tbody.replaceChildren(
		...processes.map((process) =>
			renderRow(process, rowErrors.get(process.name)),
		),
	);
}

async function runAction(action: "stop" | "restart", name: string): Promise<void> {
	pending.add(name);
	rowErrors.delete(name);
	await refresh();
	try {
		const { ok, message } = await postAction(action, name);
		if (!ok) rowErrors.set(name, message);
	} catch {
		rowErrors.set(name, "couldn't reach braid");
	} finally {
		pending.delete(name);
		await refresh();
	}
}

void loadBraidVersion();
void refresh();
setInterval(() => void refresh(), POLL_INTERVAL_MS);
