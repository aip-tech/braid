import { icon } from "./icons.js";

type PageId = "home" | "getting-started" | "config" | "cli" | "plugins";

const BASE = import.meta.env.BASE_URL;
const CHANGELOG_URL =
	"https://github.com/aip-tech/braid/blob/main/packages/braid/CHANGELOG.md";
const GITHUB_URL = "https://github.com/aip-tech/braid";
const NPM_URL = "https://www.npmjs.com/package/@aip-tech/braid";

const DOCS_PAGES: Array<{
	id: PageId;
	label: string;
	href: string;
	icon: Parameters<typeof icon>[0];
}> = [
	{
		id: "getting-started",
		label: "Getting Started",
		href: `${BASE}docs/getting-started.html`,
		icon: "rocket",
	},
	{
		id: "config",
		label: "Config",
		href: `${BASE}docs/config.html`,
		icon: "layers",
	},
	{ id: "cli", label: "CLI", href: `${BASE}docs/cli.html`, icon: "terminal" },
	{
		id: "plugins",
		label: "Plugins",
		href: `${BASE}docs/plugins.html`,
		icon: "plug",
	},
];

function currentPage(): PageId {
	const page = document.body.dataset.page;
	return (page as PageId) ?? "home";
}

function renderTopNav(): void {
	const slot = document.getElementById("topnav");
	if (!slot) return;
	const page = currentPage();
	const onDocsPage = page !== "home";

	slot.innerHTML = `
		<div class="topnav-inner">
			<a class="brand" href="${BASE}index.html">
				${icon("waypoints")}
				<span>braid</span>
			</a>
			<button class="menu-toggle" id="menu-toggle" aria-label="Toggle navigation" aria-expanded="false">
				${icon("menu")}
			</button>
			<div class="topnav-links" id="topnav-links">
				<a href="${BASE}docs/getting-started.html" class="${onDocsPage ? "active" : ""}">Docs</a>
				<a href="${CHANGELOG_URL}">Changelog</a>
				<a href="${GITHUB_URL}" class="icon-link">${icon("github")}<span>GitHub</span></a>
				<a href="${NPM_URL}" class="icon-link">${icon("npm")}<span>npm</span></a>
			</div>
		</div>
	`;

	const toggle = document.getElementById("menu-toggle");
	const links = document.getElementById("topnav-links");
	toggle?.addEventListener("click", () => {
		const expanded = toggle.getAttribute("aria-expanded") === "true";
		toggle.setAttribute("aria-expanded", String(!expanded));
		links?.classList.toggle("open", !expanded);
	});
}

function renderSidebar(): void {
	const slot = document.getElementById("sidebar");
	if (!slot) return;
	const page = currentPage();

	slot.innerHTML = `
		<nav class="sidebar-nav">
			${DOCS_PAGES.map(
				(entry) => `
				<a href="${entry.href}" class="${entry.id === page ? "active" : ""}">
					${icon(entry.icon)}
					<span>${entry.label}</span>
				</a>
			`,
			).join("")}
		</nav>
	`;
}

export function renderLayout(): void {
	renderTopNav();
	renderSidebar();
}
