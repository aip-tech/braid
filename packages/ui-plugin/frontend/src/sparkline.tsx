type SparklineProps = {
	values: number[];
	width?: number;
	height?: number;
};

/**
 * Minimal inline-SVG rolling line chart - no axes, no interactivity, just a shape to eyeball a
 * trend. Hand-rolled rather than a charting dependency: two passive series of ~30 points redrawn
 * every couple of seconds doesn't clear this codebase's dependency bar (see the roadmap doc's
 * uPlot note) - a library's bundle cost wouldn't be buying anything a plain polyline can't already
 * do here. Scaled against the series' own max (floored to avoid a division by zero when every
 * sample so far is 0) rather than a fixed ceiling, since cpu% and memory bytes have very different
 * natural ranges.
 */
export function Sparkline({
	values,
	width = 160,
	height = 32,
}: SparklineProps) {
	if (values.length < 2) return null;
	const max = Math.max(...values, 0.0001);
	const step = width / (values.length - 1);
	const points = values
		.map(
			(v, i) =>
				`${(i * step).toFixed(1)},${(height - (v / max) * height).toFixed(1)}`,
		)
		.join(" ");
	const fillPoints = `0,${height} ${points} ${width},${height}`;

	return (
		<svg
			viewBox={`0 0 ${width} ${height}`}
			width={width}
			height={height}
			class="sparkline"
			aria-hidden="true"
		>
			<polygon points={fillPoints} class="sparkline-fill" />
			<polyline points={points} class="sparkline-line" fill="none" />
		</svg>
	);
}
