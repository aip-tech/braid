import {
	formatCpu,
	formatMemory,
	formatStarted,
	type ProcessStatus,
} from "./api.js";
import { RestartIcon, StartIcon, StopIcon } from "./icons.js";

type TableViewProps = {
	processes: ProcessStatus[];
	pending: Set<string>;
	rowErrors: Map<string, string>;
	onAction: (action: "stop" | "restart" | "start", name: string) => void;
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
					<th>CPU</th>
					<th>Mem</th>
					<th>Started</th>
					<th />
				</tr>
			</thead>
			<tbody>
				{sorted.map((process) => {
					const busy = pending.has(process.name);
					const rowError = rowErrors.get(process.name);
					// A configured process that's never been started (autoStart: false, not yet
					// manually started) has no startedAt at all - distinct from "stopped", which ran
					// before and has since exited. Only offer Start for it, not Restart: routing a
					// genuine first start through the restart action would wrongly cascade to its
					// own dependents, which a real first start must not do.
					const neverStarted = process.startedAt === undefined;
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
									{process.alive
										? "running"
										: neverStarted
											? "not started"
											: "stopped"}
								</span>
							</td>
							<td class="stat-cell">
								{process.cpu !== undefined ? formatCpu(process.cpu) : "–"}
							</td>
							<td class="stat-cell">
								{process.memory !== undefined
									? formatMemory(process.memory)
									: "–"}
							</td>
							<td>{formatStarted(process.startedAt)}</td>
							<td>
								{neverStarted ? (
									<button
										type="button"
										class="btn-icon btn-restart"
										disabled={busy}
										onClick={() => onAction("start", process.name)}
									>
										<StartIcon />
										{busy ? "..." : "Start"}
									</button>
								) : (
									<>
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
									</>
								)}
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}
