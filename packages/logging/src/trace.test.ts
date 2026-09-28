import { describe, expect, it } from "vitest";
import {
	acceptTraceparent,
	childTraceparent,
	parseTraceparent,
	rootTraceparent,
	traceFields,
} from "./trace.ts";

const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("trace context", () => {
	it("parses a valid traceparent", () => {
		expect(parseTraceparent(VALID)).toEqual({
			traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
			spanId: "00f067aa0ba902b7",
			flags: "01",
		});
	});

	it.each([
		["an all-zero trace id", "00-00000000000000000000000000000000-00f067aa0ba902b7-01"],
		["an all-zero span id", "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"],
		["version ff", "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"],
		["upper case", VALID.toUpperCase()],
		["a short trace id", "00-4bf92f3577b34da6-00f067aa0ba902b7-01"],
		["garbage", "hello"],
	])("refuses %s", (_, value) => {
		expect(parseTraceparent(value)).toBeNull();
	});

	it("starts a child span in the parent's trace, and a new trace without a parent", () => {
		const child = parseTraceparent(childTraceparent(VALID));
		expect(child?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
		expect(child?.spanId).not.toBe("00f067aa0ba902b7");
		const fresh = parseTraceparent(childTraceparent("broken"));
		expect(fresh?.traceId).not.toBe("4bf92f3577b34da6a3ce929d0e0e4736");
		expect(parseTraceparent(rootTraceparent())).not.toBeNull();
		expect(rootTraceparent()).not.toBe(rootTraceparent());
	});

	it("keeps a valid incoming context and replaces an invalid one", () => {
		expect(acceptTraceparent(VALID)).toBe(VALID);
		expect(parseTraceparent(acceptTraceparent(undefined))).not.toBeNull();
	});

	it("gives log fields only for a valid context", () => {
		expect(traceFields(VALID)).toEqual({
			trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
			span_id: "00f067aa0ba902b7",
		});
		expect(traceFields(null)).toEqual({});
	});
});
