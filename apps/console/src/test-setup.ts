import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Shared by every console component test (wired into the root `unit` Vitest project): extends
// `expect` with jest-dom's DOM matchers (and, importantly, their ambient `vitest` module types —
// `@testing-library/jest-dom/vitest`, not the bare `matchers` entry, is what makes
// `expect(...).toBeInTheDocument()` type-check) and unmounts whatever the previous test rendered,
// since this project does not run Vitest with `globals: true` and so gets neither for free.
afterEach(() => {
	cleanup();
});
