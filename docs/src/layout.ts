import { icon } from "./icons.js";

/**
 * Everything every page shares - top nav, sidebar, "On this page", previous/next links and the
 * page footer - is rendered here from one page list, so each page's HTML is only its own content.
 */

type IconName = Parameters<typeof icon>[0];

type Page = {
	id: string;
	label: string;
	path: string;
	icon: IconName;
};

type Group = { heading: string; pages: Page[] };

const BASE = import.meta.env.BASE_URL;
const REPO_URL = "https://github.com/aip-tech/braid";
const CHANGELOG_URL = `${REPO_URL}/blob/main/packages/braid/CHANGELOG.md`;
const NPM_URL = "https://www.npmjs.com/package/@aip-tech/braid";
const THEME_KEY = "braid-theme";

export const GROUPS: Group[] = [
	{
		heading: "Start here",
		pages: [
			{
				id: "getting-started",
				label: "Getting started",
				path: "docs/getting-started.html",
				icon: "rocket",
			},
		],
	},
	{
		heading: "Guides",
		pages: [
			{
				id: "config",
				label: "Configuration",
				path: "docs/config.html",
				icon: "layers",
			},
			{
				id: "plugins",
				label: "Plugins",
				path: "docs/plugins.html",
				icon: "plug",
			},
		],
	},
	{
		heading: "Reference",
		pages: [
			{
				id: "reference",
				label: "Config options",
				path: "docs/reference.html",
				icon: "sliders",
			},
			{ id: "cli", label: "CLI", path: "docs/cli.html", icon: "terminal" },
			{
				id: "plugin-api",
				label: "Plugin API",
				path: "docs/plugin-api.html",
				icon: "code",
			},
		],
	},
	{
		heading: "Packages",
		pages: [
			{
				id: "ui-plugin",
				label: "Web dashboard",
				path: "docs/ui-plugin.html",
				icon: "monitor",
			},
		],
	},
];

const PAGES = GROUPS.flatMap((group) => group.pages);

function currentPageId(): string {
	return document.body.dataset.page ?? "home";
}

function href(page: Page): string {
	return `${BASE}${page.path}`;
}

// ---------- Theme ----------

type Theme = "light" | "dark";

function storedTheme(): Theme | undefined {
	try {
		const value = localStorage.getItem(THEME_KEY);
		return value === "light" || value === "dark" ? value : undefined;
	} catch {
		return undefined;
	}
}

function effectiveTheme(): Theme {
	const stored = storedTheme();
	if (stored) return stored;
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

function setTheme(theme: Theme): void {
	document.documentElement.dataset.theme = theme;
	try {
		localStorage.setItem(THEME_KEY, theme);
	} catch {
		// Storage blocked: the choice still holds for this page.
	}
}

function themeButtonIcon(): string {
	// Shows what a click switches to.
	return effectiveTheme() === "dark" ? icon("sun") : icon("moon");
}

// ---------- Top nav ----------

function renderTopNav(): void {
	const slot = document.getElementById("topnav");
	if (!slot) return;
	const onDocs = currentPageId() !== "home";
	slot.innerHTML = `
		<div class="topnav-inner">
			${
				onDocs
					? `<button class="icon-button menu-toggle" id="menu-toggle" aria-label="Open navigation" aria-expanded="false" aria-controls="sidebar">${icon("menu")}</button>`
					: ""
			}
			<a class="brand" href="${BASE}">
				${icon("waypoints")}<span>braid</span>
			</a>
			<span class="version-badge">v${__BRAID_VERSION__}</span>
			<nav class="topnav-links" aria-label="Site">
				<a href="${BASE}docs/getting-started.html" class="hide-sm ${onDocs ? "active" : ""}">Docs</a>
				<a href="${CHANGELOG_URL}" class="hide-sm">Changelog</a>
				<a href="${REPO_URL}" aria-label="GitHub">${icon("github")}</a>
				<a href="${NPM_URL}" aria-label="npm">${icon("npm")}</a>
				<button class="icon-button" id="theme-toggle" type="button" aria-label="Toggle dark mode">${themeButtonIcon()}</button>
			</nav>
		</div>
	`;

	const themeToggle = document.getElementById("theme-toggle");
	themeToggle?.addEventListener("click", () => {
		setTheme(effectiveTheme() === "dark" ? "light" : "dark");
		themeToggle.innerHTML = themeButtonIcon();
	});

	const menuToggle = document.getElementById("menu-toggle");
	if (!menuToggle) return;
	const backdrop = document.createElement("div");
	backdrop.className = "nav-backdrop";
	document.body.append(backdrop);
	const setOpen = (open: boolean) => {
		document.body.classList.toggle("nav-open", open);
		menuToggle.setAttribute("aria-expanded", String(open));
		menuToggle.setAttribute(
			"aria-label",
			open ? "Close navigation" : "Open navigation",
		);
	};
	menuToggle.addEventListener("click", () =>
		setOpen(!document.body.classList.contains("nav-open")),
	);
	backdrop.addEventListener("click", () => setOpen(false));
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") setOpen(false);
	});
}

// ---------- Sidebar ----------

function renderSidebar(): void {
	const slot = document.getElementById("sidebar");
	if (!slot) return;
	const current = currentPageId();
	slot.setAttribute("aria-label", "Documentation");
	slot.innerHTML = GROUPS.map(
		(group) => `
		<div class="sidebar-group">
			<p class="sidebar-heading">${group.heading}</p>
			${group.pages
				.map(
					(page) =>
						`<a href="${href(page)}"${page.id === current ? ' class="active" aria-current="page"' : ""}>${icon(page.icon)}<span>${page.label}</span></a>`,
				)
				.join("")}
		</div>`,
	).join("");
}

// ---------- Headings: anchors + "On this page" ----------

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

function headings(): HTMLHeadingElement[] {
	return [
		...document.querySelectorAll<HTMLHeadingElement>(
			".content h2, .content h3",
		),
	].filter((heading) => !heading.closest(".card, .steps, .callout"));
}

function addHeadingAnchors(list: HTMLHeadingElement[]): void {
	for (const heading of list) {
		if (!heading.id) heading.id = slugify(heading.textContent ?? "");
		const anchor = document.createElement("a");
		anchor.className = "heading-anchor";
		anchor.href = `#${heading.id}`;
		anchor.setAttribute("aria-label", `Link to this section`);
		anchor.textContent = "#";
		heading.append(anchor);
	}
}

function renderToc(list: HTMLHeadingElement[]): void {
	const slot = document.getElementById("toc");
	if (!slot) return;
	const page = PAGES.find((entry) => entry.id === currentPageId());
	const items = list
		.map((heading) => {
			// The heading's own text, without its "#" anchor.
			const label = [...heading.childNodes]
				.filter(
					(node) =>
						!(
							node instanceof HTMLElement &&
							node.classList.contains("heading-anchor")
						),
				)
				.map((node) => node.textContent)
				.join("")
				.trim();
			return `<li><a href="#${heading.id}" class="depth-${heading.tagName === "H3" ? 3 : 2}">${label}</a></li>`;
		})
		.join("");
	slot.setAttribute("aria-label", "On this page");
	slot.innerHTML = `
		${items ? `<p class="toc-title">On this page</p><ul class="toc-list">${items}</ul>` : ""}
		${
			page
				? `<div class="toc-links"><a href="${REPO_URL}/edit/main/docs/${page.path}">${icon("pencil")}Edit this page</a></div>`
				: ""
		}
	`;

	// Highlight the section currently being read: the last heading above the top fifth of the
	// viewport.
	const links = new Map(
		[...slot.querySelectorAll<HTMLAnchorElement>(".toc-list a")].map((link) => [
			link.getAttribute("href")?.slice(1),
			link,
		]),
	);
	const update = () => {
		const threshold = window.innerHeight * 0.2;
		let active: HTMLHeadingElement | undefined;
		for (const heading of list) {
			if (heading.getBoundingClientRect().top <= threshold) active = heading;
			else break;
		}
		active ??= list[0];
		for (const [id, link] of links) {
			link.classList.toggle("active", id === active?.id);
		}
	};
	update();
	window.addEventListener("scroll", update, { passive: true });
	window.addEventListener("resize", update, { passive: true });
}

// ---------- Previous / next + footer ----------

function renderPager(): void {
	const slot = document.getElementById("pager");
	if (!slot) return;
	const index = PAGES.findIndex((page) => page.id === currentPageId());
	if (index === -1) return;
	const previous = PAGES[index - 1];
	const next = PAGES[index + 1];
	slot.className = "pager";
	slot.setAttribute("aria-label", "Previous and next pages");
	slot.innerHTML = `
		${previous ? `<a class="previous" href="${href(previous)}"><small>Previous</small><span>${previous.label}</span></a>` : ""}
		${next ? `<a class="next" href="${href(next)}"><small>Next</small><span>${next.label}</span></a>` : ""}
	`;
	slot.insertAdjacentHTML(
		"afterend",
		`<footer class="page-footer"><span>MIT licensed</span><a href="${CHANGELOG_URL}">Changelog${icon("externalLink")}</a></footer>`,
	);
}

export function renderLayout(): void {
	renderTopNav();
	renderSidebar();
	const list = headings();
	addHeadingAnchors(list);
	renderToc(list);
	renderPager();
}
