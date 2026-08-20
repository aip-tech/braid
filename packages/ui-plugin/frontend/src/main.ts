import {
	elementScroll,
	observeElementOffset,
	observeElementRect,
	Virtualizer,
} from "@tanstack/virtual-core";
import { AnsiUp } from "ansi_up";

type ProcessStatus = {
	name: string;
	pid: number | undefined;
	alive: boolean;
	startedAt: string;
};

type Route = { view: "table" } | { view: "detail"; name: string };

const POLL_INTERVAL_MS = 2000;
const INITIAL_LOG_LINES = 300;
const HISTORY_PAGE_LINES = 300;
// How many of the most recent lines the live-follow route replays on every (re)connect, including
// the very first one - deliberately small and *always* run through dedupeReplay() against whatever
// `lines` already holds, rather than trying to distinguish "first connect" (nothing to dedupe
// against yet) from "reconnect" (needs it) as separate code paths.
const RECONNECT_REPLAY_LINES = 50;
// How long to wait after a (re)connect before treating whatever's been buffered as the full replay
// batch and running the dedupe check - not a line-count threshold, because a quiet process that
// never reaches RECONNECT_REPLAY_LINES total output would otherwise never resolve at all.
const REPLAY_RESOLVE_WINDOW_MS = 400;
const LOG_RETRY_DELAY_MS = 2000;
const LOAD_OLDER_THRESHOLD_PX = 200;
// Matches font-size 0.8rem * line-height 1.4 from style.css - only an estimate for unmeasured rows,
// corrected per-row once actually rendered (see measureElement in refreshVirtualizer's onChange).
const ROW_ESTIMATE_PX = 18;
const OVERSCAN_ROWS = 12;
// Trimmed down to this many lines whenever the view is anchored at the bottom (the common case
// while live-tailing) - cheap to be strict here since it's the everyday path.
const SOFT_MAX_LOG_LINES = 5000;
// A backstop that trims even while the user is scrolled up mid-history (where trimming is visually
// disruptive) - only kicks in if a session is left open long enough to reach 4x the soft cap, so it
// firing at all is already an edge case; accepted per the design review rather than adding a scroll-
// position-aware compromise cap.
const HARD_MAX_LOG_LINES = 20_000;

const viewTable = document.querySelector("#view-table") as HTMLDivElement;
const viewDetail = document.querySelector("#view-detail") as HTMLDivElement;
const tbody = document.querySelector(
	"#processes tbody",
) as HTMLTableSectionElement;
const errorBanner = document.querySelector("#error") as HTMLParagraphElement;
const versionLabel = document.querySelector(
	"#braid-version",
) as HTMLSpanElement;

const detailName = document.querySelector("#detail-name") as HTMLElement;
const detailStatus = document.querySelector("#detail-status") as HTMLElement;
const detailPid = document.querySelector("#detail-pid") as HTMLElement;
const detailStarted = document.querySelector("#detail-started") as HTMLElement;
const detailStopButton = document.querySelector(
	"#detail-stop",
) as HTMLButtonElement;
const detailRestartButton = document.querySelector(
	"#detail-restart",
) as HTMLButtonElement;
const detailError = document.querySelector(
	"#detail-error",
) as HTMLParagraphElement;
const detailLogStatus = document.querySelector(
	"#detail-log-status",
) as HTMLParagraphElement;
const detailLog = document.querySelector("#detail-log") as HTMLDivElement;
const detailLogInner = document.querySelector(
	"#detail-log-inner",
) as HTMLDivElement;

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

// Names with a stop/restart request currently in flight - their row's/toolbar's buttons stay
// disabled and a fast refresh runs right after, rather than waiting for the next poll tick.
const pending = new Set<string>();
const rowErrors = new Map<string, string>();

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

async function runAction(
	action: "stop" | "restart",
	name: string,
): Promise<void> {
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

// ---------- Routing ----------

function parseRoute(): Route {
	const match = /^#\/process\/(.+)$/.exec(location.hash);
	if (!match) return { view: "table" };
	try {
		return { view: "detail", name: decodeURIComponent(match[1]) };
	} catch {
		return { view: "table" };
	}
}

let currentRoute: Route = { view: "table" };

function onRouteChange(): void {
	currentRoute = parseRoute();
	if (currentRoute.view === "detail") {
		startLogStream(currentRoute.name);
	} else {
		stopLogStream();
	}
	renderCurrentView();
	if (currentRoute.view === "detail") {
		// The pane was `hidden` (display:none) while on the table view, so its measured rect was
		// zero-sized until the unhide above - the ResizeObserver firing on that change should pick
		// it up on its own, but a belt-and-suspenders refresh here is cheap and avoids a blank or
		// misaligned pane if it doesn't.
		refreshVirtualizer();
	}
}

// ---------- Table view ----------

function renderRow(
	process: ProcessStatus,
	rowError: string | undefined,
): HTMLTableRowElement {
	const row = document.createElement("tr");
	const busy = pending.has(process.name);

	const nameCell = document.createElement("td");
	const nameLink = document.createElement("a");
	nameLink.href = `#/process/${encodeURIComponent(process.name)}`;
	nameLink.textContent = process.name;
	nameCell.append(nameLink);
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
	stopButton.addEventListener(
		"click",
		() => void runAction("stop", process.name),
	);

	const restartButton = document.createElement("button");
	restartButton.textContent = busy ? "..." : "Restart";
	restartButton.disabled = busy;
	restartButton.addEventListener(
		"click",
		() => void runAction("restart", process.name),
	);

	actionsCell.append(stopButton, restartButton);
	row.append(nameCell, pidCell, statusCell, startedCell, actionsCell);
	return row;
}

function renderTable(): void {
	const sorted = [...latestProcesses].sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	tbody.replaceChildren(
		...sorted.map((process) => renderRow(process, rowErrors.get(process.name))),
	);
}

// ---------- Detail view ----------

function renderDetail(name: string): void {
	const process = latestProcesses.find((p) => p.name === name);
	const busy = pending.has(name);

	detailName.textContent = name;
	detailStatus.textContent = process
		? process.alive
			? "running"
			: "stopped"
		: statusLoaded
			? "unknown"
			: "";
	detailStatus.className = process?.alive
		? "detail-status status-running"
		: "detail-status status-stopped";
	detailPid.textContent =
		process?.pid !== undefined ? String(process.pid) : "-";
	detailStarted.textContent = process ? formatStarted(process.startedAt) : "-";

	detailStopButton.textContent = busy ? "..." : "Stop";
	detailStopButton.disabled = busy || !process?.alive;
	detailRestartButton.textContent = busy ? "..." : "Restart";
	detailRestartButton.disabled = busy;

	const error = rowErrors.get(name);
	detailError.textContent = error ?? "";
	detailError.hidden = !error;
}

detailStopButton.addEventListener("click", () => {
	if (currentRoute.view === "detail") void runAction("stop", currentRoute.name);
});
detailRestartButton.addEventListener("click", () => {
	if (currentRoute.view === "detail") {
		void runAction("restart", currentRoute.name);
	}
});

// ---------- Log streaming ----------
//
// Log lines are held as a plain array (`lines`) and rendered through a single, long-lived
// @tanstack/virtual-core Virtualizer instance - only the rows actually visible (plus a small
// overscan buffer) are ever real DOM nodes, so the pane can hold far more history than the old
// flat-HTML-append design without either the DOM or a full re-render growing with it. History
// before the initial view comes from the paginated `/api/logs/history` route (see
// core-plugins/logger.ts); the live tail keeps using the existing `follow=true` route.

type LogLine = { id: number; text: string; html: string };

let nextLineId = 0;
function makeLogLine(text: string, renderer: AnsiUp): LogLine {
	return { id: nextLineId++, text, html: renderer.ansi_to_html(text) };
}

let lines: LogLine[] = [];

type ActiveStream = {
	name: string;
	controller: AbortController;
	retryTimer: ReturnType<typeof setTimeout> | undefined;
	/** Trailing bytes from the live stream not yet terminated by a newline. */
	pendingLine: string;
	/** Lines buffered from the current connection's own replay-tail, held back until
	 *  REPLAY_RESOLVE_WINDOW_MS elapses so they can be deduped against `lines` in one pass rather
	 *  than rendered (and possibly duplicated) as they arrive. */
	replayBuffer: string[];
	replayResolved: boolean;
	/** Opaque `/api/logs/history` pagination cursor; null means no older history is available. */
	historyCursor: string | null;
	historyLoading: boolean;
};

let activeStream: ActiveStream | undefined;
// The live tail's own AnsiUp instance, recreated on every (re)connect (see runLogStream) - it
// carries color/style state across lines so a multi-line colored run renders correctly, but that
// state means nothing across a dropped-and-reopened connection or a different process's stream.
let liveAnsiUp = new AnsiUp();

function showLogStatus(message: string | undefined): void {
	detailLogStatus.textContent = message ?? "";
	detailLogStatus.hidden = !message;
}

// ---- Virtualizer ----

function virtualizerOptions() {
	return {
		count: lines.length,
		getScrollElement: () => detailLog,
		estimateSize: () => ROW_ESTIMATE_PX,
		overscan: OVERSCAN_ROWS,
		getItemKey: (index: number) => lines[index]?.id ?? index,
		observeElementRect,
		observeElementOffset,
		scrollToFn: elementScroll,
		// Replaces a hand-rolled "pinned to bottom unless the user scrolled up" check: the
		// virtualizer itself only follows appended content while already within
		// scrollEndThreshold of the end, and otherwise preserves whatever the user is looking at.
		anchorTo: "end" as const,
		followOnAppend: true as const,
		onChange: () => renderVisibleRows(),
	};
}

const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>(
	virtualizerOptions(),
);
virtualizer._willUpdate();

function renderVisibleRows(): void {
	detailLogInner.style.height = `${virtualizer.getTotalSize()}px`;
	const rows = virtualizer.getVirtualItems().map((item) => {
		const row = document.createElement("div");
		row.className = "log-line";
		row.dataset.index = String(item.index);
		row.style.transform = `translateY(${item.start}px)`;
		const line = lines[item.index];
		// ansi_up escapes the plain-text portions of a line for HTML before wrapping ANSI-colored
		// spans around them (its escape_txt_for_html runs by default) - innerHTML is only safe here
		// because that escaping already happened when the line was created; raw fetched text must
		// never reach it directly.
		if (line) row.innerHTML = line.html;
		return row;
	});
	detailLogInner.replaceChildren(...rows);
	for (const row of rows) virtualizer.measureElement(row);
}

/** Call after mutating `lines` - setOptions() alone updates state but doesn't re-render. */
function refreshVirtualizer(): void {
	virtualizer.setOptions(virtualizerOptions());
	virtualizer._willUpdate();
	renderVisibleRows();
}

function trimLogLines(): void {
	// Cheap to be strict while anchored at the bottom (the common case while live-tailing).
	if (virtualizer.isAtEnd(LOAD_OLDER_THRESHOLD_PX)) {
		if (lines.length > SOFT_MAX_LOG_LINES) {
			lines.splice(0, lines.length - SOFT_MAX_LOG_LINES);
		}
		return;
	}
	// Otherwise the user is browsing history - only step in at the hard ceiling, and even then
	// trim from the loaded-history end rather than deleting what's likely still on screen.
	if (lines.length > HARD_MAX_LOG_LINES) {
		lines.splice(0, lines.length - HARD_MAX_LOG_LINES);
	}
}

// ---- Loading older history ----

function prependHistoryLines(rawLines: string[]): void {
	if (rawLines.length === 0) return;
	// A fresh instance per page, not the live stream's - a history page's true preceding color
	// context is unknown, so the first colored run in an old batch may occasionally render
	// unstyled if a real terminal would have inherited color from before the batch's start. A
	// narrow, accepted cosmetic limitation rather than replaying ANSI state from the true start of
	// the file on every page.
	const renderer = new AnsiUp();
	lines.unshift(...rawLines.map((text) => makeLogLine(text, renderer)));
	refreshVirtualizer();
}

async function loadInitialHistory(stream: ActiveStream): Promise<void> {
	try {
		const res = await fetch(
			`/api/logs/history?name=${encodeURIComponent(stream.name)}&lines=${INITIAL_LOG_LINES}`,
			{ signal: stream.controller.signal },
		);
		if (activeStream === stream && res.ok) {
			const data = (await res.json()) as {
				lines: string[];
				cursor: string | null;
			};
			if (activeStream === stream) {
				prependHistoryLines(data.lines);
				stream.historyCursor = data.cursor;
				// The initial load populates the pane in one jump rather than incrementally, which
				// isn't guaranteed to register as "content appended at the end" the way ordinary
				// live-tail growth does - scroll to the most recent line explicitly rather than
				// relying on that to happen implicitly.
				virtualizer.scrollToEnd({ behavior: "instant" });
			}
		}
	} catch {
		// Ignored - the live follow stream below still gives at least recent content via its own
		// replay, "load older" just won't have anything to offer until the page is reloaded.
	} finally {
		if (activeStream === stream) stream.historyLoading = false;
	}
	if (activeStream === stream) void runLogStream(stream);
	// A pane shorter than the viewport has no scrollbar at all, so the "scroll" listener that
	// normally drives this can never fire even though older history exists - re-check here (and
	// again at the end of loadOlderHistory) so a short log's full retained history still loads
	// without the user needing to somehow scroll a pane that isn't scrollable yet.
	maybeLoadOlder();
}

async function loadOlderHistory(stream: ActiveStream): Promise<void> {
	try {
		const res = await fetch(
			`/api/logs/history?name=${encodeURIComponent(stream.name)}&lines=${HISTORY_PAGE_LINES}&before=${encodeURIComponent(stream.historyCursor ?? "")}`,
			{ signal: stream.controller.signal },
		);
		if (activeStream === stream && res.ok) {
			const data = (await res.json()) as {
				lines: string[];
				cursor: string | null;
			};
			if (activeStream === stream) {
				prependHistoryLines(data.lines);
				stream.historyCursor = data.cursor;
			}
		}
	} catch {
		// Transient - scrolling up again retries naturally, no special state needed.
	} finally {
		if (activeStream === stream) stream.historyLoading = false;
	}
	maybeLoadOlder();
}

function maybeLoadOlder(): void {
	const stream = activeStream;
	if (!stream || stream.historyLoading || stream.historyCursor === null) return;
	if (detailLog.scrollTop > LOAD_OLDER_THRESHOLD_PX) return;
	stream.historyLoading = true;
	void loadOlderHistory(stream);
}

detailLog.addEventListener("scroll", maybeLoadOlder);

// ---- Live tail ----

function pushLiveLine(text: string): void {
	lines.push(makeLogLine(text, liveAnsiUp));
	trimLogLines();
	refreshVirtualizer();
}

/** Finds the longest prefix of `replayLines` that's already the tail of `lines`, and drops it -
 *  every (re)connect (including the very first) replays up to RECONNECT_REPLAY_LINES, which will
 *  usually overlap what's already shown (from history, or from before a dropped connection). */
function dropAlreadySeenPrefix(replayLines: string[]): string[] {
	const maxOverlap = Math.min(replayLines.length, lines.length);
	for (let overlap = maxOverlap; overlap > 0; overlap--) {
		const existingTail = lines.slice(-overlap);
		let matches = true;
		for (let i = 0; i < overlap; i++) {
			if (existingTail[i].text !== replayLines[i]) {
				matches = false;
				break;
			}
		}
		if (matches) return replayLines.slice(overlap);
	}
	return replayLines;
}

function resolveReplay(stream: ActiveStream): void {
	stream.replayResolved = true;
	const fresh = dropAlreadySeenPrefix(stream.replayBuffer);
	stream.replayBuffer = [];
	for (const text of fresh) pushLiveLine(text);
}

function handleLiveLine(stream: ActiveStream, text: string): void {
	if (stream.replayResolved) {
		pushLiveLine(text);
	} else {
		stream.replayBuffer.push(text);
	}
}

function consumeChunk(stream: ActiveStream, chunk: string): void {
	const combined = stream.pendingLine + chunk;
	const parts = combined.split("\n");
	stream.pendingLine = parts.pop() ?? "";
	for (const text of parts) handleLiveLine(stream, text);
}

function stopLogStream(): void {
	if (!activeStream) return;
	if (activeStream.retryTimer !== undefined) {
		clearTimeout(activeStream.retryTimer);
	}
	activeStream.controller.abort();
	activeStream = undefined;
}

function scheduleLogRetry(stream: ActiveStream): void {
	if (activeStream !== stream) return;
	showLogStatus("Reconnecting...");
	stream.retryTimer = setTimeout(() => {
		if (activeStream !== stream) return;
		void runLogStream(stream);
	}, LOG_RETRY_DELAY_MS);
}

async function runLogStream(stream: ActiveStream): Promise<void> {
	try {
		const res = await fetch(
			`/api/logs?name=${encodeURIComponent(stream.name)}&follow=true&lines=${RECONNECT_REPLAY_LINES}`,
			{ signal: stream.controller.signal },
		);
		if (activeStream !== stream) return;

		if (res.status === 401) {
			showLogStatus(
				"Session expired (the daemon may have restarted) - reload this page.",
			);
			return;
		}
		if (res.status === 404) {
			showLogStatus(`Unknown process "${stream.name}".`);
			return;
		}
		if (!res.ok) {
			showLogStatus(`braid: ${res.status} ${await res.text()}`);
			scheduleLogRetry(stream);
			return;
		}

		const body = res.body;
		if (!body) {
			showLogStatus("Log streaming isn't supported by this browser.");
			return;
		}

		showLogStatus(undefined);
		liveAnsiUp = new AnsiUp();
		stream.pendingLine = "";
		stream.replayBuffer = [];
		stream.replayResolved = false;
		setTimeout(() => {
			if (activeStream === stream && !stream.replayResolved) {
				resolveReplay(stream);
			}
		}, REPLAY_RESOLVE_WINDOW_MS);

		const reader = body.getReader();
		const decoder = new TextDecoder();
		while (true) {
			const { done, value } = await reader.read();
			if (activeStream !== stream) return;
			if (done) break;
			consumeChunk(stream, decoder.decode(value, { stream: true }));
		}
		consumeChunk(stream, decoder.decode());
		if (!stream.replayResolved) resolveReplay(stream);
		if (stream.pendingLine) {
			// The stream ended without a trailing newline on its last line - flush it as complete
			// rather than silently dropping it, since nothing more is coming to complete it.
			handleLiveLine(stream, stream.pendingLine);
			stream.pendingLine = "";
		}
		if (activeStream !== stream) return;
		// The server only ever closes a follow stream on daemon shutdown or a dropped connection -
		// both are worth quietly retrying rather than leaving the pane looking permanently stuck.
		scheduleLogRetry(stream);
	} catch {
		if (stream.controller.signal.aborted || activeStream !== stream) return;
		scheduleLogRetry(stream);
	}
}

function startLogStream(name: string): void {
	if (activeStream?.name === name) return;
	stopLogStream();
	lines = [];
	nextLineId = 0;
	liveAnsiUp = new AnsiUp();
	showLogStatus(undefined);
	refreshVirtualizer();
	const controller = new AbortController();
	const stream: ActiveStream = {
		name,
		controller,
		retryTimer: undefined,
		pendingLine: "",
		replayBuffer: [],
		replayResolved: false,
		historyCursor: null,
		historyLoading: true,
	};
	activeStream = stream;
	void loadInitialHistory(stream);
}

// ---------- Shared polling + rendering ----------

let latestProcesses: ProcessStatus[] = [];
let statusLoaded = false;

function renderCurrentView(): void {
	if (currentRoute.view === "table") {
		viewTable.hidden = false;
		viewDetail.hidden = true;
		renderTable();
	} else {
		viewTable.hidden = true;
		viewDetail.hidden = false;
		renderDetail(currentRoute.name);
	}
}

async function refresh(): Promise<void> {
	let res: Response;
	try {
		res = await fetch("/api/status");
	} catch {
		showBanner("Lost connection to braid - is the daemon still running?");
		return;
	}
	if (res.status === 401) {
		showBanner(
			"Session expired (the daemon may have restarted) - reload this page.",
		);
		return;
	}
	if (!res.ok) {
		showBanner(`braid: ${res.status} ${await res.text()}`);
		return;
	}
	showBanner(undefined);

	latestProcesses = (await res.json()) as ProcessStatus[];
	statusLoaded = true;
	renderCurrentView();
}

window.addEventListener("hashchange", onRouteChange);
onRouteChange();
void loadBraidVersion();
void refresh();
setInterval(() => void refresh(), POLL_INTERVAL_MS);
