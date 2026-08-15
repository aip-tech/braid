import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import typescript from "highlight.js/lib/languages/typescript";
import "highlight.js/styles/github-dark.css";
import { icon } from "./icons.js";
import { renderLayout } from "./layout.js";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("typescript", typescript);

renderLayout();
hljs.highlightAll();
addCopyButtons();

// Hover (or focus, for keyboard users) reveals a copy-to-clipboard button on every code block -
// added after highlightAll() so it sits alongside the highlighted markup, not inside it.
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
