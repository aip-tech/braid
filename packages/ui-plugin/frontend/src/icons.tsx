import type { ComponentChildren } from "preact";

// Small inline icon set for the dashboard's buttons/links - stroke-based, matching the brand
// mark's own style (round caps/joins, currentColor), so buttons look drawn by the same hand as the
// logo rather than borrowed from an icon font. Deliberately hand-rolled instead of an icon
// dependency: five tiny paths don't meet the dependency bar in the roadmap doc.

type IconProps = { class?: string };

function Icon({
	class: className,
	children,
}: IconProps & { children: ComponentChildren }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
			class={`icon${className ? ` ${className}` : ""}`}
		>
			{children}
		</svg>
	);
}

export function StopIcon(props: IconProps) {
	return (
		<Icon {...props}>
			<rect
				x="5"
				y="5"
				width="14"
				height="14"
				rx="2.5"
				fill="currentColor"
				stroke="none"
			/>
		</Icon>
	);
}

export function RestartIcon(props: IconProps) {
	return (
		<Icon {...props}>
			<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" />
			<path d="M3 3v5h5" />
		</Icon>
	);
}

export function BackIcon(props: IconProps) {
	return (
		<Icon {...props}>
			<path d="M14 6 8 12l6 6" />
		</Icon>
	);
}

export function HistoryUpIcon(props: IconProps) {
	return (
		<Icon {...props}>
			<path d="M6 15l6-6 6 6" />
		</Icon>
	);
}
