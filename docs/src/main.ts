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
