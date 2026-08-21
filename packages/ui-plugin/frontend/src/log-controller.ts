import {
	elementScroll,
	observeElementOffset,
	observeElementRect,
	Virtualizer,
} from "@tanstack/virtual-core";
import { AnsiUp } from "ansi_up";

// Log lines are held as a plain array (`lines`) and rendered through a single
// @tanstack/virtual-core Virtualizer instance - only the rows actually visible (plus a small
// overscan buffer) are ever real DOM nodes, so the pane can hold far more history than a flat-
// HTML-append design without either the DOM or a full re-render growing with it. History before
// the initial view comes from the paginated `/api/logs/history` route (see core-plugins/logger.ts);
// the live tail keeps using the existing `follow=true` route.
//
// This is deliberately framework-agnostic (no Preact import here) - a headless virtualizer plus
// hand-rolled DOM writes is the same escape hatch a React/Preact integration would reach for
// anyway, so there's nothing to gain from routing it through component state, and real cost
// (re-deriving the anchor-preservation/measurement-timing behavior fixed in 0.2.2) in doing so.

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
// Used only by trimLogLines' isAtEnd() check, not for triggering a load - "load older" is purely
// button-driven (see LoadOlderState for why).
const AT_END_THRESHOLD_PX = 200;
// Matches font-size 0.8rem * line-height 1.4 from style.css - only an estimate for unmeasured rows,
// corrected per-row once actually rendered (see measureElement in renderVisibleRows).
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

type LogLine = { id: number; text: string; html: string };

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

export type LoadOlderState = { hidden: boolean; loading: boolean };

export type LogControllerCallbacks = {
	onStatusChange: (message: string | undefined) => void;
	onLoadOlderStateChange: (state: LoadOlderState) => void;
};

/** Owns one process's log pane: streaming, history pagination, and the virtualizer that renders
 *  it. One instance per mount of the log pane - create fresh on mount, `destroy()` on unmount. */
export class LogController {
	private readonly logEl: HTMLDivElement;
	private readonly logInnerEl: HTMLDivElement;
	private readonly callbacks: LogControllerCallbacks;
	private readonly virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
	private readonly unmountVirtualizer: () => void;

	private lines: LogLine[] = [];
	private nextLineId = 0;
	private activeStream: ActiveStream | undefined;
	// Recreated on every (re)connect (see runLogStream) - it carries color/style state across lines
	// so a multi-line colored run renders correctly, but that state means nothing across a dropped-
	// and-reopened connection or a different process's stream.
	private liveAnsiUp = new AnsiUp();

	constructor(
		logEl: HTMLDivElement,
		logInnerEl: HTMLDivElement,
		callbacks: LogControllerCallbacks,
	) {
		this.logEl = logEl;
		this.logInnerEl = logInnerEl;
		this.callbacks = callbacks;
		this.virtualizer = new Virtualizer(this.virtualizerOptions());
		// _didMount()'s return value is the only public teardown hook (cleanup() itself is private) -
		// grabbed here for destroy() to call later. It doesn't perform the subscription itself, so the
		// explicit _willUpdate() below is still required.
		this.unmountVirtualizer = this.virtualizer._didMount();
		this.virtualizer._willUpdate();
	}

	/** Starts (or restarts, if `name` differs) streaming a process's log. No-op if already
	 *  streaming this same name. */
	start(name: string): void {
		if (this.activeStream?.name === name) return;
		this.stop();
		this.lines = [];
		this.nextLineId = 0;
		this.liveAnsiUp = new AnsiUp();
		this.callbacks.onStatusChange(undefined);
		this.refreshVirtualizer();
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
		this.activeStream = stream;
		void this.loadInitialHistory(stream);
	}

	stop(): void {
		if (!this.activeStream) return;
		if (this.activeStream.retryTimer !== undefined) {
			clearTimeout(this.activeStream.retryTimer);
		}
		this.activeStream.controller.abort();
		this.activeStream = undefined;
	}

	loadOlder(): void {
		const stream = this.activeStream;
		if (!stream || stream.historyLoading || stream.historyCursor === null)
			return;
		stream.historyLoading = true;
		this.reportLoadOlderState();
		void this.loadOlderHistory(stream);
	}

	/** Releases the virtualizer's ResizeObserver/scroll listeners, on top of stop()'s abort - call
	 *  once when the log pane unmounts. */
	destroy(): void {
		this.stop();
		this.unmountVirtualizer();
	}

	private makeLogLine(text: string, renderer: AnsiUp): LogLine {
		return { id: this.nextLineId++, text, html: renderer.ansi_to_html(text) };
	}

	// ---- Virtualizer ----

	private virtualizerOptions() {
		// Captured once per call rather than read live off `this.lines`: setOptions() below compares
		// this object against the *previous* one it was given to detect which keys moved, so that
		// previous object's getItemKey must keep resolving against the array as it was at that call,
		// not whatever `this.lines` has since become. That only holds if code which shifts existing
		// indices (prependHistoryLines' prepend, trimLogLines' front-trim) replaces `this.lines` with
		// a new array instead of mutating in place; a pure append (pushLiveLine) is fine either way
		// since it never changes an existing line's index.
		const snapshot = this.lines;
		return {
			count: snapshot.length,
			getScrollElement: () => this.logEl,
			estimateSize: () => ROW_ESTIMATE_PX,
			overscan: OVERSCAN_ROWS,
			getItemKey: (index: number) => snapshot[index]?.id ?? index,
			observeElementRect,
			observeElementOffset,
			scrollToFn: elementScroll,
			// Replaces a hand-rolled "pinned to bottom unless the user scrolled up" check: the
			// virtualizer itself only follows appended content while already within
			// scrollEndThreshold of the end, and otherwise preserves whatever the user is looking at.
			anchorTo: "end" as const,
			followOnAppend: true as const,
			onChange: () => this.renderVisibleRows(),
		};
	}

	private renderVisibleRows(): void {
		this.logInnerEl.style.height = `${this.virtualizer.getTotalSize()}px`;
		const rows = this.virtualizer.getVirtualItems().map((item) => {
			const row = document.createElement("div");
			row.className = "log-line";
			row.dataset.index = String(item.index);
			row.style.transform = `translateY(${item.start}px)`;
			const line = this.lines[item.index];
			// ansi_up escapes the plain-text portions of a line for HTML before wrapping ANSI-colored
			// spans around them (its escape_txt_for_html runs by default) - innerHTML is only safe
			// here because that escaping already happened when the line was created; raw fetched text
			// must never reach it directly.
			if (line) row.innerHTML = line.html;
			return row;
		});
		this.logInnerEl.replaceChildren(...rows);
		for (const row of rows) this.virtualizer.measureElement(row);
	}

	/** Call after mutating `this.lines` - setOptions() alone updates state but doesn't re-render. */
	private refreshVirtualizer(): void {
		this.virtualizer.setOptions(this.virtualizerOptions());
		// Grow (or shrink) the scrollable area to match the new item count *before* _willUpdate()
		// runs: prepending history moves anchorTo:"end"'s preserved-position scroll offset forward
		// via a scrollTo() call inside _willUpdate(), but the browser clamps that to the pane's
		// *current* scrollable range - if the pane is still sized for the old, shorter content when
		// that runs, the clamp silently discards the adjustment and leaves the pane scrolled to
		// what's now a mid-air gap above the actual rendered rows (visually blank until the user's
		// own scroll nudges it back in sync). Sizing first gives scrollTo() room to land where the
		// virtualizer intends.
		this.logInnerEl.style.height = `${this.virtualizer.getTotalSize()}px`;
		this.virtualizer._willUpdate();
		this.renderVisibleRows();
	}

	private trimLogLines(): void {
		// Slices to a new array rather than splicing in place - see virtualizerOptions' snapshot
		// comment for why `this.lines` must never be mutated in place.
		// Cheap to be strict while anchored at the bottom (the common case while live-tailing).
		if (this.virtualizer.isAtEnd(AT_END_THRESHOLD_PX)) {
			if (this.lines.length > SOFT_MAX_LOG_LINES) {
				this.lines = this.lines.slice(this.lines.length - SOFT_MAX_LOG_LINES);
			}
			return;
		}
		// Otherwise the user is browsing history - only step in at the hard ceiling, and even then
		// trim from the loaded-history end rather than deleting what's likely still on screen.
		if (this.lines.length > HARD_MAX_LOG_LINES) {
			this.lines = this.lines.slice(this.lines.length - HARD_MAX_LOG_LINES);
		}
	}

	// ---- Loading older history ----

	private prependHistoryLines(rawLines: string[]): void {
		if (rawLines.length === 0) return;
		// A fresh instance per page, not the live stream's - a history page's true preceding color
		// context is unknown, so the first colored run in an old batch may occasionally render
		// unstyled if a real terminal would have inherited color from before the batch's start. A
		// narrow, accepted cosmetic limitation rather than replaying ANSI state from the true start
		// of the file on every page.
		const renderer = new AnsiUp();
		this.lines = [
			...rawLines.map((text) => this.makeLogLine(text, renderer)),
			...this.lines,
		];
		this.refreshVirtualizer();
	}

	private async loadInitialHistory(stream: ActiveStream): Promise<void> {
		try {
			const res = await fetch(
				`/api/logs/history?name=${encodeURIComponent(stream.name)}&lines=${INITIAL_LOG_LINES}`,
				{ signal: stream.controller.signal },
			);
			if (this.activeStream === stream && res.ok) {
				const data = (await res.json()) as {
					lines: string[];
					cursor: string | null;
				};
				if (this.activeStream === stream) {
					this.prependHistoryLines(data.lines);
					stream.historyCursor = data.cursor;
					// The initial load populates the pane in one jump rather than incrementally, which
					// isn't guaranteed to register as "content appended at the end" the way ordinary
					// live-tail growth does - scroll to the most recent line explicitly rather than
					// relying on that to happen implicitly.
					this.virtualizer.scrollToEnd({ behavior: "instant" });
				}
			}
		} catch {
			// Ignored - the live follow stream below still gives at least recent content via its own
			// replay, "load older" just won't have anything to offer until the page is reloaded.
		} finally {
			if (this.activeStream === stream) stream.historyLoading = false;
		}
		if (this.activeStream === stream) void this.runLogStream(stream);
		this.reportLoadOlderState();
	}

	private async loadOlderHistory(stream: ActiveStream): Promise<void> {
		try {
			const res = await fetch(
				`/api/logs/history?name=${encodeURIComponent(stream.name)}&lines=${HISTORY_PAGE_LINES}&before=${encodeURIComponent(stream.historyCursor ?? "")}`,
				{ signal: stream.controller.signal },
			);
			if (this.activeStream === stream && res.ok) {
				const data = (await res.json()) as {
					lines: string[];
					cursor: string | null;
				};
				if (this.activeStream === stream) {
					this.prependHistoryLines(data.lines);
					stream.historyCursor = data.cursor;
				}
			}
		} catch {
			// Transient - clicking "load older" again retries naturally, no special state needed.
		} finally {
			if (this.activeStream === stream) stream.historyLoading = false;
		}
		this.reportLoadOlderState();
	}

	// A pane shorter than the viewport has no scrollbar at all, so a scroll-driven "load older"
	// trigger could never fire for a quiet process even with lots more history available. An earlier
	// version of this auto-loaded in that case, but a fetch's own prepend nudges scrollTop via the
	// virtualizer's anchor-preservation, which can refire an automatic scroll-based check before the
	// browser's actually settled that adjustment - for a process whose retained history spans many
	// pages, that raced into a tight loop and visibly corrupted the pane's layout. An explicit button
	// sidesteps this entirely: exactly one fetch per click, no auto-retriggering, and no surprise
	// history dump on first open either.
	private reportLoadOlderState(): void {
		const stream = this.activeStream;
		const hasMore = stream !== undefined && stream.historyCursor !== null;
		this.callbacks.onLoadOlderStateChange({
			hidden: !hasMore,
			loading: hasMore ? stream.historyLoading : false,
		});
	}

	// ---- Live tail ----

	private pushLiveLine(text: string): void {
		// In-place push is safe here (unlike the front-affecting mutations in prependHistoryLines and
		// trimLogLines - see virtualizerOptions' snapshot comment): appending never changes the index
		// of an existing line, so the previous snapshot's indices stay valid even after this mutates
		// it.
		this.lines.push(this.makeLogLine(text, this.liveAnsiUp));
		this.trimLogLines();
		this.refreshVirtualizer();
	}

	/** Finds the longest prefix of `replayLines` that's already the tail of `this.lines`, and drops
	 *  it - every (re)connect (including the very first) replays up to RECONNECT_REPLAY_LINES, which
	 *  will usually overlap what's already shown (from history, or from before a dropped
	 *  connection). */
	private dropAlreadySeenPrefix(replayLines: string[]): string[] {
		const maxOverlap = Math.min(replayLines.length, this.lines.length);
		for (let overlap = maxOverlap; overlap > 0; overlap--) {
			const existingTail = this.lines.slice(-overlap);
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

	private resolveReplay(stream: ActiveStream): void {
		stream.replayResolved = true;
		const fresh = this.dropAlreadySeenPrefix(stream.replayBuffer);
		stream.replayBuffer = [];
		for (const text of fresh) this.pushLiveLine(text);
	}

	private handleLiveLine(stream: ActiveStream, text: string): void {
		if (stream.replayResolved) {
			this.pushLiveLine(text);
		} else {
			stream.replayBuffer.push(text);
		}
	}

	private consumeChunk(stream: ActiveStream, chunk: string): void {
		const combined = stream.pendingLine + chunk;
		const parts = combined.split("\n");
		stream.pendingLine = parts.pop() ?? "";
		for (const text of parts) this.handleLiveLine(stream, text);
	}

	private scheduleLogRetry(stream: ActiveStream): void {
		if (this.activeStream !== stream) return;
		this.callbacks.onStatusChange("Reconnecting...");
		stream.retryTimer = setTimeout(() => {
			if (this.activeStream !== stream) return;
			void this.runLogStream(stream);
		}, LOG_RETRY_DELAY_MS);
	}

	private async runLogStream(stream: ActiveStream): Promise<void> {
		try {
			const res = await fetch(
				`/api/logs?name=${encodeURIComponent(stream.name)}&follow=true&lines=${RECONNECT_REPLAY_LINES}`,
				{ signal: stream.controller.signal },
			);
			if (this.activeStream !== stream) return;

			if (res.status === 401) {
				this.callbacks.onStatusChange(
					"Session expired (the daemon may have restarted) - reload this page.",
				);
				return;
			}
			if (res.status === 404) {
				this.callbacks.onStatusChange(`Unknown process "${stream.name}".`);
				return;
			}
			if (!res.ok) {
				this.callbacks.onStatusChange(
					`braid: ${res.status} ${await res.text()}`,
				);
				this.scheduleLogRetry(stream);
				return;
			}

			const body = res.body;
			if (!body) {
				this.callbacks.onStatusChange(
					"Log streaming isn't supported by this browser.",
				);
				return;
			}

			this.callbacks.onStatusChange(undefined);
			this.liveAnsiUp = new AnsiUp();
			stream.pendingLine = "";
			stream.replayBuffer = [];
			stream.replayResolved = false;
			setTimeout(() => {
				if (this.activeStream === stream && !stream.replayResolved) {
					this.resolveReplay(stream);
				}
			}, REPLAY_RESOLVE_WINDOW_MS);

			const reader = body.getReader();
			const decoder = new TextDecoder();
			while (true) {
				const { done, value } = await reader.read();
				if (this.activeStream !== stream) return;
				if (done) break;
				this.consumeChunk(stream, decoder.decode(value, { stream: true }));
			}
			this.consumeChunk(stream, decoder.decode());
			if (!stream.replayResolved) this.resolveReplay(stream);
			if (stream.pendingLine) {
				// The stream ended without a trailing newline on its last line - flush it as complete
				// rather than silently dropping it, since nothing more is coming to complete it.
				this.handleLiveLine(stream, stream.pendingLine);
				stream.pendingLine = "";
			}
			if (this.activeStream !== stream) return;
			// The server only ever closes a follow stream on daemon shutdown or a dropped connection -
			// both are worth quietly retrying rather than leaving the pane looking permanently stuck.
			this.scheduleLogRetry(stream);
		} catch {
			if (stream.controller.signal.aborted || this.activeStream !== stream)
				return;
			this.scheduleLogRetry(stream);
		}
	}
}
