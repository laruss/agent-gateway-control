import { randomBytes } from "node:crypto";

/**
 * W3C trace context (`traceparent`), propagated from an event to the runs, jobs, deliveries
 * and tool actions it causes, and bound into their log lines as `trace_id` and `span_id`. The
 * Gateway exports no spans: a trace id joins the log lines of one causal chain across
 * processes. A trace id is diagnostic, never authority.
 */
export type TraceContext = Readonly<{ traceId: string; spanId: string; flags: string }>;

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

/** The trace context of a `traceparent` value, or null if it is not a valid one. */
export function parseTraceparent(value: string | null | undefined): TraceContext | null {
	const match = TRACEPARENT.exec(value ?? "");
	if (match === null) {
		return null;
	}
	const [, version, traceId, spanId, flags] = match;
	if (
		version === undefined ||
		traceId === undefined ||
		spanId === undefined ||
		flags === undefined ||
		version === "ff" ||
		// Version 00 has exactly these four fields; later versions may append more, which the
		// pattern already refuses.
		traceId === ZERO_TRACE ||
		spanId === ZERO_SPAN
	) {
		return null;
	}
	return { traceId, spanId, flags };
}

export function formatTraceparent(context: TraceContext): string {
	return `00-${context.traceId}-${context.spanId}-${context.flags}`;
}

function randomHex(bytes: number, zero: string): string {
	for (;;) {
		const hex = randomBytes(bytes).toString("hex");
		if (hex !== zero) {
			return hex;
		}
	}
}

/** A new trace. */
export function rootTraceparent(): string {
	return formatTraceparent({
		traceId: randomHex(16, ZERO_TRACE),
		spanId: randomHex(8, ZERO_SPAN),
		flags: "01",
	});
}

/**
 * A new span in the parent's trace, for the next step of its work: a run of an event, an
 * attempt of a run, a delivery. A missing or invalid parent starts a new trace.
 */
export function childTraceparent(parent: string | null | undefined): string {
	const context = parseTraceparent(parent);
	if (context === null) {
		return rootTraceparent();
	}
	return formatTraceparent({ ...context, spanId: randomHex(8, ZERO_SPAN) });
}

/** The valid `traceparent`, else a new trace: what an incoming event is stored with. */
export function acceptTraceparent(value: string | null | undefined): string {
	const context = parseTraceparent(value);
	return context === null ? rootTraceparent() : formatTraceparent(context);
}

/** Log fields of a trace context; nothing for a missing or invalid one. */
export function traceFields(
	value: string | null | undefined,
): Readonly<{ trace_id?: string; span_id?: string }> {
	const context = parseTraceparent(value);
	return context === null ? {} : { trace_id: context.traceId, span_id: context.spanId };
}
