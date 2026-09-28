import { describe, expect, it } from "vitest";
import { gauge, MetricsRegistry, registerProcessMetrics, renderMetrics } from "./metrics.ts";

describe("metrics", () => {
	it("renders counters, histograms and scrape-time gauges in the text format", async () => {
		const registry = new MetricsRegistry();
		const runs = registry.counter("gateway_test_runs_total", "Runs.");
		runs.inc({ outcome: "completed" });
		runs.inc({ outcome: "completed" });
		runs.inc({ outcome: "failed" }, 3);
		const durations = registry.histogram("gateway_test_seconds", "Durations.", [1, 10]);
		durations.observe(0.5);
		durations.observe(5);
		registry.collect(() => [
			gauge("gateway_test_queue", "Queue.", [{ labels: { queue: 'a"b\\c' }, value: 2 }]),
		]);
		const text = await registry.render();
		expect(text).toContain("# TYPE gateway_test_runs_total counter");
		expect(text).toContain('gateway_test_runs_total{outcome="completed"} 2');
		expect(text).toContain('gateway_test_runs_total{outcome="failed"} 3');
		expect(text).toContain('gateway_test_seconds_bucket{le="1"} 1');
		expect(text).toContain('gateway_test_seconds_bucket{le="10"} 2');
		expect(text).toContain('gateway_test_seconds_bucket{le="+Inf"} 2');
		expect(text).toContain("gateway_test_seconds_sum 5.5");
		expect(text).toContain("gateway_test_seconds_count 2");
		expect(text).toContain('gateway_test_queue{queue="a\\"b\\\\c"} 2');
		expect(text.endsWith("\n")).toBe(true);
	});

	it("keeps a failing collector from hiding the others", async () => {
		const registry = new MetricsRegistry();
		registry.collect(() => {
			throw new Error("database down");
		});
		registry.collect(() => [gauge("gateway_test_up", "Up.", [{ labels: {}, value: 1 }])]);
		expect(await registry.render()).toContain("gateway_test_up 1");
	});

	it("refuses invalid names and the reserved le label", () => {
		const registry = new MetricsRegistry();
		expect(() => registry.counter("bad-name", "x")).toThrow("invalid metric name");
		const counter = registry.counter("gateway_ok_total", "x");
		expect(() => counter.inc({ le: "1" })).toThrow("invalid label name");
		expect(() => gauge("gateway_ok", "x", [{ labels: { "bad-label": "1" }, value: 1 }])).toThrow();
	});

	it("reports build information and process gauges", async () => {
		const registry = new MetricsRegistry();
		const stop = registerProcessMetrics(registry, { service: "worker", version: "1.2.3" });
		const text = await registry.render();
		stop();
		expect(text).toContain('gateway_build_info{service="worker",version="1.2.3"} 1');
		expect(text).toMatch(/process_resident_memory_bytes \d+/u);
		expect(text).toContain("process_event_loop_delay_seconds");
	});

	it("renders special values", () => {
		const text = renderMetrics([
			gauge("gateway_test_special", "x", [
				{ labels: { v: "nan" }, value: Number.NaN },
				{ labels: { v: "inf" }, value: Number.POSITIVE_INFINITY },
			]),
		]);
		expect(text).toContain('gateway_test_special{v="nan"} NaN');
		expect(text).toContain('gateway_test_special{v="inf"} +Inf');
	});
});
