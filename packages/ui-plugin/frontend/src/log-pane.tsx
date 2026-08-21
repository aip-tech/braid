import { useEffect, useRef, useState } from "preact/hooks";
import { HistoryUpIcon } from "./icons.js";
import { type LoadOlderState, LogController } from "./log-controller.js";

type LogPaneProps = { name: string };

/** Thin Preact wrapper around LogController - the pane's own DOM (virtualized rows, scroll
 *  position) stays outside Preact's diffing entirely, same as any headless-virtualizer
 *  integration; only the status line and "Load older" button are component state. */
export function LogPane({ name }: LogPaneProps) {
	const logRef = useRef<HTMLDivElement>(null);
	const logInnerRef = useRef<HTMLDivElement>(null);
	const controllerRef = useRef<LogController | null>(null);
	const [status, setStatus] = useState<string | undefined>(undefined);
	const [loadOlder, setLoadOlder] = useState<LoadOlderState>({
		hidden: true,
		loading: false,
	});

	// Mount-only: one controller (and one virtualizer) per pane instance. `start`/`destroy` are
	// driven by the effect below and by unmount, not by this effect re-running.
	useEffect(() => {
		const controller = new LogController(
			logRef.current as HTMLDivElement,
			logInnerRef.current as HTMLDivElement,
			{
				onStatusChange: setStatus,
				onLoadOlderStateChange: setLoadOlder,
			},
		);
		controllerRef.current = controller;
		return () => {
			controller.destroy();
			controllerRef.current = null;
		};
	}, []);

	// Covers both the initial mount and navigating directly between two detail views (browser
	// back/forward without passing through the table) - start() itself no-ops if already streaming
	// this same name.
	useEffect(() => {
		controllerRef.current?.start(name);
	}, [name]);

	return (
		<>
			<p class="error" hidden={!status}>
				{status}
			</p>
			<button
				type="button"
				class="btn-icon load-older"
				hidden={loadOlder.hidden}
				disabled={loadOlder.loading}
				onClick={() => controllerRef.current?.loadOlder()}
			>
				<HistoryUpIcon />
				{loadOlder.loading ? "Loading..." : "Load older lines"}
			</button>
			<div ref={logRef} class="log-pane">
				<div ref={logInnerRef} class="log-pane-inner" />
			</div>
		</>
	);
}
