import { formatStarted, type ProcessStatus } from "./api.js";
import { RestartIcon, StopIcon } from "./icons.js";

type TableViewProps = {
	processes: ProcessStatus[];
	pending: Set<string>;
	rowErrors: Map<string, string>;
	onAction: (action: "stop" | "restart", name: string) => void;
};

export function TableView({
	processes,
	pending,
	rowErrors,
	onAction,
}: TableViewProps) {
	const sorted = [...processes].sort((a, b) => a.name.localeCompare(b.name));
	return (
		<table id="processes">
			<thead>
				<tr>
					<th>Name</th>
					<th>PID</th>
					<th>Status</th>
					<th>Started</th>
					<th />
				</tr>
			</thead>
			<tbody>
				{sorted.map((process) => {
					const busy = pending.has(process.name);
					const rowError = rowErrors.get(process.name);
					return (
						<tr key={process.name}>
							<td>
								<a href={`#/process/${encodeURIComponent(process.name)}`}>
									{process.name}
								</a>
								{rowError && <div class="row-error">{rowError}</div>}
							</td>
							<td>
								<span class="badge badge-pid">
									{process.pid !== undefined ? String(process.pid) : "-"}
								</span>
							</td>
							<td>
								<span
									class={`badge badge-status ${process.alive ? "status-running" : "status-stopped"}`}
								>
									{process.alive ? "running" : "stopped"}
								</span>
							</td>
							<td>{formatStarted(process.startedAt)}</td>
							<td>
								<button
									type="button"
									class="btn-icon btn-stop"
									disabled={busy || !process.alive}
									onClick={() => onAction("stop", process.name)}
								>
									<StopIcon />
									{busy ? "..." : "Stop"}
								</button>
								<button
									type="button"
									class="btn-icon btn-restart"
									disabled={busy}
									onClick={() => onAction("restart", process.name)}
								>
									<RestartIcon />
									{busy ? "..." : "Restart"}
								</button>
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}
