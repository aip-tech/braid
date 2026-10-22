import { StringDecoder } from "node:string_decoder";

const COLOR_CODES: Record<string, string> = {
	black: "30",
	red: "31",
	green: "32",
	yellow: "33",
	blue: "34",
	magenta: "35",
	cyan: "36",
	white: "37",
	gray: "90",
};

export function colorize(text: string, color?: string): string {
	const code = color ? COLOR_CODES[color] : undefined;
	return code ? `\x1b[${code}m${text}\x1b[0m` : text;
}

// The well-known `ansi-regex` pattern (sindresorhus/ansi-regex), vendored rather than hand-rolled:
// a process's own raw output is unconstrained (it can emit its own colors, OSC 8 hyperlinks, cursor
// movement), so a narrower SGR-color-only pattern would under-strip and leave stray escape bytes in
// text meant to be machine-parsed (see `logs --json`, the one consumer of this).
const ANSI_PATTERN = [
	"[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)",
	"(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
].join("|");

/** Strips ANSI escape sequences (color, cursor movement, OSC hyperlinks, ...) from `text`. */
export function stripAnsi(text: string): string {
	return text.replace(new RegExp(ANSI_PATTERN, "g"), "");
}

// linePrefixer's optional `HH:MM:SS.mmm ` timestamp, once colors are stripped.
const TIMESTAMP_PREFIX = /^\d{2}:\d{2}:\d{2}\.\d{3} /;

/**
 * The app's own text from one line of a process's prefixed output: colors stripped (braid's and
 * the app's own), then braid's timestamp and `[name] ` prefix removed. Undefined for braid's own
 * `braid: ...` notices, which are in the same stream but aren't the app's output.
 */
export function appLineText(line: string, name: string): string | undefined {
	let text = stripAnsi(line).replace(TIMESTAMP_PREFIX, "");
	const tag = `[${name}] `;
	if (text.startsWith(tag)) text = text.slice(tag.length);
	return text.startsWith("braid: ") ? undefined : text;
}

// Every process gets its own configured color for its "[name]" prefix - braid's own messages
// (and plugins') use one fixed, neutral color instead, so they read as clearly "not a process"
// wherever they appear alongside real process output (most visibly interleaved in `--foreground`).
const INTERNAL_TAG_COLOR = "gray";

/** The tag `emitDiagnostic`/crash/failure messages use: `colorize("[braid]", "gray")`. */
export function braidTag(): string {
	return colorize("[braid]", INTERNAL_TAG_COLOR);
}

/** The tag a plugin's own `ctx.log()` output uses: `colorize('[plugin:name]', "gray")`. */
export function pluginTag(pluginName: string): string {
	return colorize(`[plugin:${pluginName}]`, INTERNAL_TAG_COLOR);
}

export type LinePrefixer = {
	/** Buffers partial lines across chunks and writes each complete line to `target`, prefixed. */
	write(chunk: Buffer | string): void;
	/** Flushes any trailing partial line (no trailing newline) as its own line. */
	flush(): void;
};

function pad(n: number, width = 2): string {
	return String(n).padStart(width, "0");
}

/** `HH:MM:SS.mmm` in local time - no date, since a rotated log's total retention is bounded to a
 *  couple of megabytes either side of "now" (see DEFAULT_LOG_MAX_SIZE_BYTES), never spans enough
 *  real time for the date to matter the way it would for long-term-archived logs. */
function formatTimestamp(date: Date): string {
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** `sink` receives each already-prefixed, newline-terminated line - a real stream's `write`, or anything else. */
export function linePrefixer(
	sink: (line: string) => void,
	name: string,
	color?: string,
	timestamps = false,
): LinePrefixer {
	const namePrefix = `${colorize(`[${name}]`, color)} `;
	let buffer = "";
	// A pipe hands over output in arbitrary byte chunks, so a multi-byte character (é, 日, an
	// emoji) can be split across two of them. Decoding each chunk on its own would turn both
	// halves into U+FFFD; the decoder holds an incomplete character back until the rest arrives.
	const decoder = new StringDecoder("utf8");

	function prefixFor(): string {
		if (!timestamps) return namePrefix;
		// Computed per line, not once per chunk/flush - several lines can land in one chunk, each
		// deserving its own real emission time rather than all sharing the chunk's arrival time.
		return `${colorize(formatTimestamp(new Date()), "gray")} ${namePrefix}`;
	}

	return {
		write(chunk) {
			buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
			const lines = buffer.split("\n");
			// istanbul ignore next -- String.split always returns at least one element (even for an
			// empty string), so pop() here can never actually be undefined.
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				sink(`${prefixFor()}${line}\n`);
			}
		},
		flush() {
			// Whatever the decoder was still holding (a truncated character at the very end).
			buffer += decoder.end();
			if (buffer.length > 0) {
				sink(`${prefixFor()}${buffer}\n`);
				buffer = "";
			}
		},
	};
}
