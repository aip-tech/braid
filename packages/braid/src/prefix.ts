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

	function prefixFor(): string {
		if (!timestamps) return namePrefix;
		// Computed per line, not once per chunk/flush - several lines can land in one chunk, each
		// deserving its own real emission time rather than all sharing the chunk's arrival time.
		return `${colorize(formatTimestamp(new Date()), "gray")} ${namePrefix}`;
	}

	return {
		write(chunk) {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				sink(`${prefixFor()}${line}\n`);
			}
		},
		flush() {
			if (buffer.length > 0) {
				sink(`${prefixFor()}${buffer}\n`);
				buffer = "";
			}
		},
	};
}
