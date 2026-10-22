import { render } from "preact";
import { App } from "./app.js";
import { readToken } from "./auth.js";

// Before the first render: the token leaves the URL fragment before the router reads it.
readToken();

render(<App />, document.getElementById("root") as HTMLElement);
