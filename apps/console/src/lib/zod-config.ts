import { z } from "zod";

// The console's CSP forbids `'unsafe-eval'` (no page here ever needs it). Zod builds each
// object schema's fast parser at *construction* time, not on first use — `ConsoleStatusSchema`
// and friends are built the moment `@agent-gateway/contracts` is imported, which for this app is
// during the very first module evaluation, well before any of our own code gets to run. That
// construction reads `globalConfig.jitless` to decide whether to probe `new Function(...)` for
// its JIT-compiled fast path; the probe itself catches the resulting error and degrades
// gracefully, but the browser still reports the caught throw as a CSP violation before the catch
// ever runs. Setting `jitless` here — in a module `main.tsx` imports *first*, before anything
// that transitively constructs a schema — skips the probe entirely, which is Zod's own
// documented fix for exactly this CSP interaction, so parsing every `/api/*` response never
// produces one.
z.config({ jitless: true });
