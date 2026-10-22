/**
 * The control-server token, as this page knows it. braid prints the dashboard's URL with the token
 * in the fragment (`.../#token=...`): browsers never send a fragment to any server, so it can't end
 * up in a request log or a Referer the way a query string or cookie could. On load, readToken moves
 * it into sessionStorage (so a reload keeps working) and removes it from the address bar; every
 * request then carries it as `Authorization: Bearer`, via authFetch.
 */

/** The bits of `window` readToken touches - injectable for tests. */
export type TokenEnvironment = {
	location: Pick<Location, "hash" | "host" | "pathname" | "search">;
	history: Pick<History, "replaceState">;
	storage: Pick<Storage, "getItem" | "setItem"> | undefined;
};

/** Shown when the server refuses the token this page has (the daemon restarted with a new one). */
export const TOKEN_REJECTED_MESSAGE =
	"braid didn't accept this page's access token (the daemon may have restarted) - open the dashboard link it printed when it started.";
/** Shown when this page has no token at all (opened without the `#token=` link braid printed). */
export const NO_TOKEN_MESSAGE =
	"No access token - open the dashboard link braid printed when it started (it ends in #token=...).";

let token: string | undefined;

/** sessionStorage is per-tab and per-origin already; keyed by host too, so two braid dashboards
 *  for two projects (two ports on 127.0.0.1, same browser) keep separate tokens. */
function storageKey(host: string): string {
	return `braid-token:${host}`;
}

/**
 * Takes the token out of the URL fragment if it's there, otherwise falls back to the one this tab
 * stored earlier. Any other fragment content (the dashboard's own `#/process/<name>` routes) is
 * left in place. Returns the token, which authFetch then sends.
 */
export function readToken(
	env: TokenEnvironment = defaultEnvironment(),
): string | undefined {
	const { location, history, storage } = env;
	const params = new URLSearchParams(location.hash.replace(/^#/, ""));
	const fromUrl = params.get("token");
	if (fromUrl) {
		token = fromUrl;
		try {
			storage?.setItem(storageKey(location.host), fromUrl);
		} catch {
			// Storage blocked (some private modes): the token still works until a reload.
		}
		// Only the token goes; anything else in the fragment stays.
		params.delete("token");
		const rest = params.toString();
		history.replaceState(
			null,
			"",
			`${location.pathname}${location.search}${rest ? `#${rest}` : ""}`,
		);
		return token;
	}
	try {
		token = storage?.getItem(storageKey(location.host)) ?? undefined;
	} catch {
		token = undefined;
	}
	return token;
}

function defaultEnvironment(): TokenEnvironment {
	let storage: Storage | undefined;
	try {
		storage = window.sessionStorage;
	} catch {
		storage = undefined;
	}
	return { location: window.location, history: window.history, storage };
}

/** What to tell the user when braid refuses a request with a 401 - which depends on whether this
 *  page had a token to send at all. */
export function unauthorizedMessage(): string {
	return token === undefined ? NO_TOKEN_MESSAGE : TOKEN_REJECTED_MESSAGE;
}

/** For tests: set (or clear) the token directly. */
export function setToken(value: string | undefined): void {
	token = value;
}

/** `fetch`, plus the token as `Authorization: Bearer` when this page has one. */
export function authFetch(
	input: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
	return fetch(input, { ...init, headers });
}
