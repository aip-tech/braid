import { useCallback, useEffect, useState } from "preact/hooks";
import {
	fetchBraidVersion,
	type HistorySample,
	type ProcessStatus,
	postAction,
} from "./api.js";
import { DetailView } from "./detail-view.js";
import { TableView } from "./table-view.js";

const POLL_INTERVAL_MS = 2000;
// ~1 minute of history at the poll cadence above - enough for a sparkline to show a real trend
// without growing unbounded for a long-running dashboard tab.
const HISTORY_LENGTH = 30;

type Route = { view: "table" } | { view: "detail"; name: string };

function parseRoute(): Route {
	const match = /^#\/process\/(.+)$/.exec(location.hash);
	if (!match) return { view: "table" };
	try {
		return { view: "detail", name: decodeURIComponent(match[1]) };
	} catch {
		return { view: "table" };
	}
}

function useRoute(): Route {
	const [route, setRoute] = useState<Route>(() => parseRoute());
	useEffect(() => {
		const onHashChange = () => setRoute(parseRoute());
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);
	return route;
}

export function App() {
	const route = useRoute();
	const [processes, setProcesses] = useState<ProcessStatus[]>([]);
	const [statusLoaded, setStatusLoaded] = useState(false);
	// Per-process rolling cpu/memory samples, fed to the detail view's sparklines. A fresh Map is
	// built on every append (not mutated in place) so this state update stands on its own rather
	// than silently riding on the unrelated setProcesses() call's re-render.
	const [history, setHistory] = useState<Map<string, HistorySample[]>>(
		new Map(),
	);
	const [banner, setBanner] = useState<string | undefined>(undefined);
	// Names with a stop/restart request currently in flight - their row's/toolbar's buttons stay
	// disabled and a fast refresh runs right after, rather than waiting for the next poll tick.
	const [pending, setPending] = useState<Set<string>>(new Set());
	const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map());
	const [braidVersion, setBraidVersion] = useState<string | undefined>(
		undefined,
	);

	useEffect(() => {
		void fetchBraidVersion().then(setBraidVersion);
	}, []);

	const refreshStatus = useCallback(async () => {
		let res: Response;
		try {
			res = await fetch("/api/status");
		} catch {
			setBanner("Lost connection to braid - is the daemon still running?");
			return;
		}
		if (res.status === 401) {
			setBanner(
				"Session expired (the daemon may have restarted) - reload this page.",
			);
			return;
		}
		if (!res.ok) {
			setBanner(`braid: ${res.status} ${await res.text()}`);
			return;
		}
		setBanner(undefined);
		const data = (await res.json()) as ProcessStatus[];
		setProcesses(data);
		setStatusLoaded(true);
		setHistory((prev) => {
			const next = new Map(prev);
			for (const process of data) {
				if (process.cpu === undefined || process.memory === undefined) {
					continue;
				}
				const samples = next.get(process.name) ?? [];
				next.set(
					process.name,
					[...samples, { cpu: process.cpu, memory: process.memory }].slice(
						-HISTORY_LENGTH,
					),
				);
			}
			return next;
		});
	}, []);

	useEffect(() => {
		void refreshStatus();
		const id = setInterval(() => void refreshStatus(), POLL_INTERVAL_MS);
		return () => clearInterval(id);
	}, [refreshStatus]);

	const runAction = useCallback(
		async (action: "stop" | "restart", name: string) => {
			setPending((prev) => new Set(prev).add(name));
			setRowErrors((prev) => {
				const next = new Map(prev);
				next.delete(name);
				return next;
			});
			await refreshStatus();
			try {
				const { ok, message } = await postAction(action, name);
				if (!ok) {
					setRowErrors((prev) => new Map(prev).set(name, message));
				}
			} catch {
				setRowErrors((prev) => new Map(prev).set(name, "couldn't reach braid"));
			} finally {
				setPending((prev) => {
					const next = new Set(prev);
					next.delete(name);
					return next;
				});
				await refreshStatus();
			}
		},
		[refreshStatus],
	);

	return (
		<>
			<div id="topnav">
				<div class="topnav-inner">
					<span class="brand">
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.6"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<circle cx="4.5" cy="19.5" r="2.5" />
							<circle cx="19.5" cy="4.5" r="2.5" />
							<path d="M6.5 17.5 17.5 6.5" />
							<path d="M8.5 6.5h2a2 2 0 0 1 2 2v7" />
						</svg>
						<span>braid</span>
					</span>
					<span class="topnav-version">
						{braidVersion ? `v${braidVersion}` : ""}
					</span>
				</div>
			</div>
			<main>
				<p class="error" hidden={!banner}>
					{banner}
				</p>
				{route.view === "table" ? (
					<TableView
						processes={processes}
						pending={pending}
						rowErrors={rowErrors}
						onAction={runAction}
					/>
				) : (
					<DetailView
						name={route.name}
						process={processes.find((p) => p.name === route.name)}
						statusLoaded={statusLoaded}
						history={history.get(route.name) ?? []}
						pending={pending}
						rowErrors={rowErrors}
						onAction={runAction}
					/>
				)}
			</main>
		</>
	);
}
