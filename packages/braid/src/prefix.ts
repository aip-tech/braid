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

export type LinePrefixer = {
	/** Buffers partial lines across chunks and writes each complete line to `target`, prefixed. */
	write(chunk: Buffer | string): void;
	/** Flushes any trailing partial line (no trailing newline) as its own line. */
	flush(): void;
};

/** `sink` receives each already-prefixed, newline-terminated line - a real stream's `write`, or anything else. */
export function linePrefixer(
	sink: (line: string) => void,
	name: string,
	color?: string,
): LinePrefixer {
	const prefix = `${colorize(`[${name}]`, color)} `;
	let buffer = "";

	return {
		write(chunk) {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				sink(`${prefix}${line}\n`);
			}
		},
		flush() {
			if (buffer.length > 0) {
				sink(`${prefix}${buffer}\n`);
				buffer = "";
			}
		},
	};
}
