// nodemon ships no types of its own. This declares only the slice of its programmatic API
// (https://github.com/remy/nodemon#nodemon-and-forever) that worker.ts actually uses.
declare module "nodemon" {
	type NodemonSettings = {
		exec?: string;
		args?: string[];
		watch?: string[];
		ext?: string;
		stdout?: boolean;
		env?: Record<string, string>;
	};

	type NodemonReadableEmitter = {
		stdout: NodeJS.ReadableStream;
		stderr: NodeJS.ReadableStream;
	};

	type NodemonInstance = {
		on(
			event: "readable",
			listener: (this: NodemonReadableEmitter) => void,
		): NodemonInstance;
		on(event: "crash", listener: () => void): NodemonInstance;
		on(event: "quit", listener: () => void): NodemonInstance;
	};

	function nodemon(settings: NodemonSettings): NodemonInstance;
	export = nodemon;
}
