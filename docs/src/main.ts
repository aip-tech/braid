import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import typescript from "highlight.js/lib/languages/typescript";
import "highlight.js/styles/github-dark.css";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("typescript", typescript);
hljs.highlightAll();

const sections = document.querySelectorAll<HTMLElement>("main section[id]");
const navLinks = document.querySelectorAll<HTMLAnchorElement>("nav a");

const setActive = (id: string) => {
	for (const link of navLinks) {
		link.classList.toggle("active", link.getAttribute("href") === `#${id}`);
	}
};

const observer = new IntersectionObserver(
	(entries) => {
		for (const entry of entries) {
			if (entry.isIntersecting) {
				setActive(entry.target.id);
			}
		}
	},
	{ rootMargin: "-40% 0px -55% 0px" },
);

for (const section of sections) {
	observer.observe(section);
}
