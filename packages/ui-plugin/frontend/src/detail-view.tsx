import {
	formatCpu,
	formatMemory,
	formatStarted,
	type HistorySample,
	type ProcessStatus,
} from "./api.js";
import { BackIcon, RestartIcon, StopIcon } from "./icons.js";
import { LogPane } from "./log-pane.js";
import { Sparkline } from "./sparkline.js";

type DetailViewProps = {
	name: string;
	process: ProcessStatus | undefined;
	statusLoaded: boolean;
	history: HistorySample[];
	pending: Set<string>;
	rowErrors: Map<string, string>;
	onAction: (action: "stop" | "restart", name: string) => void;
};

export function DetailView({
	name,
	process,
	statusLoaded,
	history,
	pending,
	rowErrors,
	onAction,
}: DetailViewProps) {
	const busy = pending.has(name);
	const rowError = rowErrors.get(name);

	return (
		<div>
			<p class="detail-back">
				<a href="#/">
					<BackIcon />
					All processes
				</a>
			</p>
			<div class="detail-toolbar">
				<div class="detail-heading">
					<h1>{name}</h1>
					<span
						class={`badge badge-status ${process?.alive ? "status-running" : "status-stopped"}`}
					>
						{process
							? process.alive
								? "running"
								: "stopped"
							: statusLoaded
								? "unknown"
								: ""}
					</span>
				</div>
				<div class="detail-meta">
					<span>
						PID{" "}
						<span class="badge badge-pid">
							{process?.pid !== undefined ? String(process.pid) : "-"}
						</span>
					</span>
					<span>
						Started {process ? formatStarted(process.startedAt) : "-"}
					</span>
				</div>
				<div class="detail-actions">
					<button
						type="button"
						class="btn-icon btn-stop"
						disabled={busy || !process?.alive}
						onClick={() => onAction("stop", name)}
					>
						<StopIcon />
						{busy ? "..." : "Stop"}
					</button>
					<button
						type="button"
						class="btn-icon btn-restart"
						disabled={busy}
						onClick={() => onAction("restart", name)}
					>
						<RestartIcon />
						{busy ? "..." : "Restart"}
					</button>
				</div>
			</div>
			<p class="row-error" hidden={!rowError}>
				{rowError}
			</p>
			{history.length > 1 && (
				<div class="charts">
					<div class="chart-card">
						<div class="chart-label">
							<span>CPU</span>
							<span class="chart-value">
								{formatCpu(history[history.length - 1].cpu)}
							</span>
						</div>
						<Sparkline values={history.map((sample) => sample.cpu)} />
					</div>
					<div class="chart-card">
						<div class="chart-label">
							<span>Memory</span>
							<span class="chart-value">
								{formatMemory(history[history.length - 1].memory)}
							</span>
						</div>
						<Sparkline values={history.map((sample) => sample.memory)} />
					</div>
				</div>
			)}
			<LogPane name={name} />
		</div>
	);
}
