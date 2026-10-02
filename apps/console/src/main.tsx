// Must be the very first import: it sets Zod's `jitless` config before anything else in this
// module graph gets a chance to construct a schema (see the module's own comment for why that
// ordering matters for the CSP).
import "@/lib/zod-config";
import * as React from "react";
import * as ReactDOM from "react-dom/client";
import { App } from "@/App";
import "@/index.css";

const root = document.getElementById("root");
if (root === null) {
	throw new Error("missing #root element");
}

ReactDOM.createRoot(root).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);
