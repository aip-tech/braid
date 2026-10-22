import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import typescript from "highlight.js/lib/languages/typescript";
import { icon } from "./icons.js";
import { renderLayout } from "./layout.js";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("typescript", typescript);

renderLayout();
renderIcons();
renderCallouts();
renderTabs();
hljs.highlightAll();
addCopyButtons();

/** Fills every `<span data-icon="name">` with that icon, so page markup can name one. */
function renderIcons(): void {
	for (const slot of document.querySelectorAll<HTMLElement>("[data-icon]")) {
		slot.innerHTML = icon(slot.dataset.icon as Parameters<typeof icon>[0]);
	}
}

/** Gives each `.callout` its icon and default title, so the page markup is just the text. */
function renderCallouts(): void {
	const kinds = {
		note: { title: "Note", icon: "info" },
		tip: { title: "Tip", icon: "lightbulb" },
		warning: { title: "Caution", icon: "alert" },
	} as const;
	for (const callout of document.querySelectorAll<HTMLElement>(".callout")) {
		const kind =
			(Object.keys(kinds) as Array<keyof typeof kinds>).find((name) =>
				callout.classList.contains(`callout-${name}`),
			) ?? "note";
		const title = document.createElement("p");
		title.className = "callout-title";
		title.innerHTML = `${icon(kinds[kind].icon)}<span>${callout.dataset.title ?? kinds[kind].title}</span>`;
		callout.prepend(title);
	}
}

/**
 * `<div class="tabs" data-group="pm">` with `.tab-panel[data-label]` children becomes a tab strip.
 * Tabs sharing a `data-group` switch together, and the choice is remembered (e.g. pnpm everywhere).
 */
function renderTabs(): void {
	const storageKey = (group: string) => `braid-tabs:${group}`;
	const read = (group: string) => {
		try {
			return localStorage.getItem(storageKey(group)) ?? undefined;
		} catch {
			return undefined;
		}
	};
	const groups = new Map<string, Array<(label: string) => void>>();
	document.querySelectorAll<HTMLElement>(".tabs").forEach((tabs, index) => {
		const panels = [
			...tabs.querySelectorAll<HTMLElement>(":scope > .tab-panel"),
		];
		const group = tabs.dataset.group ?? `tabs-${index}`;
		const list = document.createElement("div");
		list.className = "tab-list";
		list.setAttribute("role", "tablist");
		const buttons = panels.map((panel, panelIndex) => {
			const button = document.createElement("button");
			button.type = "button";
			button.setAttribute("role", "tab");
			button.textContent = panel.dataset.label ?? `Tab ${panelIndex + 1}`;
			const id = `${group}-${index}-${panelIndex}`;
			panel.id = `panel-${id}`;
			panel.setAttribute("role", "tabpanel");
			button.setAttribute("aria-controls", panel.id);
			button.addEventListener("click", () => {
				const label = panel.dataset.label ?? "";
				for (const select of groups.get(group) ?? []) select(label);
				try {
					localStorage.setItem(storageKey(group), label);
				} catch {
					// Storage blocked: the switch still applies to this page.
				}
			});
			list.append(button);
			return button;
		});
		tabs.prepend(list);
		const select = (label: string) => {
			const chosen = Math.max(
				0,
				panels.findIndex((panel) => panel.dataset.label === label),
			);
			panels.forEach((panel, panelIndex) => {
				panel.hidden = panelIndex !== chosen;
				buttons[panelIndex]?.setAttribute(
					"aria-selected",
					String(panelIndex === chosen),
				);
			});
		};
		select(read(group) ?? panels[0]?.dataset.label ?? "");
		groups.set(group, [...(groups.get(group) ?? []), select]);
	});
}

// Hover (or focus, for keyboard users) reveals a copy-to-clipboard button on every code block.
function addCopyButtons(): void {
	for (const pre of document.querySelectorAll<HTMLPreElement>("pre")) {
		const code = pre.querySelector("code");
		if (!code) continue;

		const button = document.createElement("button");
		button.type = "button";
		button.className = "copy-btn";
		button.setAttribute("aria-label", "Copy to clipboard");
		button.innerHTML = icon("copy");
		pre.append(button);

		button.addEventListener("click", () => {
			void copyText(code.innerText).then((copied) => {
				if (!copied) return;
				button.innerHTML = icon("check");
				button.classList.add("copied");
				setTimeout(() => {
					button.innerHTML = icon("copy");
					button.classList.remove("copied");
				}, 1500);
			});
		});
	}
}

// Falls back to the legacy execCommand approach when the async Clipboard API is unavailable or
// its permission is denied (some embedded/automated browser contexts don't grant it at all).
async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const textarea = document.createElement("textarea");
		textarea.value = text;
		textarea.style.position = "fixed";
		textarea.style.opacity = "0";
		document.body.append(textarea);
		textarea.select();
		let copied = false;
		try {
			copied = document.execCommand("copy");
		} catch {
			copied = false;
		}
		textarea.remove();
		return copied;
	}
}
