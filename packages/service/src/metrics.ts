/**
 * A small Prometheus registry (text exposition format 0.0.4): counters and histograms kept in
 * process, gauges computed when scraped. Labels are bounded by construction: services, adapters,
 * queues, statuses and outcomes, never message, run or user ids.
 */
export type Labels = Readonly<Record<string, string>>;

/** One line of a family; `suffix` names a histogram's `_bucket`, `_sum` and `_count`. */
type Sample = Readonly<{ labels: Labels; value: number; suffix?: string }>;

/** A metric family as it is rendered. */
export type MetricFamily = Readonly<{
	name: string;
	help: string;
	type: "counter" | "gauge" | "histogram";
	samples: Readonly<Sample[]>;
}>;

/** Computes gauges when scraped; a collector that throws renders nothing of its own. */
export type Collector = () => Promise<Readonly<MetricFamily[]>> | Readonly<MetricFamily[]>;

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/u;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;

function escapeLabel(value: string): string {
	return value.replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n").replace(/"/gu, '\\"');
}

function formatLabels(labels: Labels): string {
	const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) {
		return "";
	}
	return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

function formatValue(value: number): string {
	if (Number.isNaN(value)) {
		return "NaN";
	}
	if (!Number.isFinite(value)) {
		return value > 0 ? "+Inf" : "-Inf";
	}
	return String(value);
}

function labelKey(labels: Labels): string {
	return formatLabels(labels);
}

function checkName(name: string, labels: Labels): void {
	if (!NAME.test(name)) {
		throw new Error(`invalid metric name '${name}'`);
	}
	for (const key of Object.keys(labels)) {
		if (!LABEL.test(key) || key === "le") {
			throw new Error(`invalid label name '${key}' on '${name}'`);
		}
	}
}

/** Renders families in the text exposition format. */
export function renderMetrics(families: Readonly<MetricFamily[]>): string {
	const lines: string[] = [];
	for (const family of families) {
		lines.push(`# HELP ${family.name} ${family.help.replace(/\n/gu, " ")}`);
		lines.push(`# TYPE ${family.name} ${family.type}`);
		for (const sample of family.samples) {
			const name = `${family.name}${sample.suffix ?? ""}`;
			lines.push(`${name}${formatLabels(sample.labels)} ${formatValue(sample.value)}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

export type Counter = Readonly<{ inc: (labels?: Labels, by?: number) => void }>;
export type Histogram = Readonly<{
	observe: (value: number, labels?: Labels) => void;
}>;

type HistogramState = { buckets: number[]; sum: number; count: number; labels: Labels };

/** Default duration buckets, in seconds: a turn runs from seconds to an hour. */
export const DURATION_BUCKETS: Readonly<number[]> = [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600];

export class MetricsRegistry {
	private readonly counters = new Map<string, { help: string; values: Map<string, Sample> }>();
	private readonly histograms = new Map<
		string,
		{ help: string; bounds: Readonly<number[]>; values: Map<string, HistogramState> }
	>();
	private readonly collectors: Collector[] = [];

	/** A monotonic counter, e.g. `gateway_worker_runs_total{outcome}`. */
	counter(name: string, help: string): Counter {
		checkName(name, {});
		const family = { help, values: new Map<string, Sample>() };
		this.counters.set(name, family);
		return {
			inc: (labels = {}, by = 1) => {
				checkName(name, labels);
				const key = labelKey(labels);
				const current = family.values.get(key)?.value ?? 0;
				family.values.set(key, { labels, value: current + by });
			},
		};
	}

	histogram(name: string, help: string, bounds: Readonly<number[]> = DURATION_BUCKETS): Histogram {
		checkName(name, {});
		const family = { help, bounds, values: new Map<string, HistogramState>() };
		this.histograms.set(name, family);
		return {
			observe: (value, labels = {}) => {
				checkName(name, labels);
				const key = labelKey(labels);
				const state = family.values.get(key) ?? {
					buckets: bounds.map(() => 0),
					sum: 0,
					count: 0,
					labels,
				};
				bounds.forEach((bound, index) => {
					if (value <= bound) {
						state.buckets[index] = (state.buckets[index] ?? 0) + 1;
					}
				});
				state.sum += value;
				state.count += 1;
				family.values.set(key, state);
			},
		};
	}

	/** Adds scrape-time gauges. */
	collect(collector: Collector): void {
		this.collectors.push(collector);
	}

	async render(): Promise<string> {
		const families: MetricFamily[] = [];
		for (const [name, family] of this.counters) {
			families.push({
				name,
				help: family.help,
				type: "counter",
				samples: [...family.values.values()],
			});
		}
		for (const [name, family] of this.histograms) {
			const samples: Sample[] = [];
			for (const state of family.values.values()) {
				family.bounds.forEach((bound, index) => {
					samples.push({
						labels: { ...state.labels, le: formatValue(bound) },
						value: state.buckets[index] ?? 0,
						suffix: "_bucket",
					});
				});
				samples.push({
					labels: { ...state.labels, le: "+Inf" },
					value: state.count,
					suffix: "_bucket",
				});
				samples.push({ labels: state.labels, value: state.sum, suffix: "_sum" });
				samples.push({ labels: state.labels, value: state.count, suffix: "_count" });
			}
			families.push({ name, help: family.help, type: "histogram", samples });
		}
		for (const collector of this.collectors) {
			try {
				families.push(...(await collector()));
			} catch {
				// A failing collector reports its own failure metric; it hides nothing else.
			}
		}
		return renderMetrics(families);
	}
}

/** A gauge family from samples. */
export function gauge(name: string, help: string, samples: Readonly<Sample[]>): MetricFamily {
	for (const sample of samples) {
		checkName(name, sample.labels);
	}
	return { name, help, type: "gauge", samples };
}

export type ProcessMetricsOptions = Readonly<{ service: string; version: string }>;

/**
 * Build information, uptime, memory, CPU and event loop delay of this process. The event loop
 * delay is the worst lateness of a 500 ms timer since the last scrape.
 */
export function registerProcessMetrics(
	registry: MetricsRegistry,
	options: ProcessMetricsOptions,
): () => void {
	const started = Date.now();
	let expected = Date.now() + 500;
	let worstDelayMs = 0;
	const timer = setInterval(() => {
		const now = Date.now();
		worstDelayMs = Math.max(worstDelayMs, now - expected);
		expected = now + 500;
	}, 500);
	timer.unref();
	registry.collect(() => {
		const memory = process.memoryUsage();
		const cpu = process.cpuUsage();
		const delay = worstDelayMs;
		worstDelayMs = 0;
		return [
			gauge("gateway_build_info", "The running service and version.", [
				{ labels: { service: options.service, version: options.version }, value: 1 },
			]),
			gauge("process_uptime_seconds", "Seconds since the process started.", [
				{ labels: {}, value: (Date.now() - started) / 1000 },
			]),
			gauge("process_resident_memory_bytes", "Resident memory.", [
				{ labels: {}, value: memory.rss },
			]),
			gauge("process_heap_used_bytes", "JavaScript heap in use.", [
				{ labels: {}, value: memory.heapUsed },
			]),
			gauge("process_cpu_seconds", "User plus system CPU time.", [
				{ labels: {}, value: (cpu.user + cpu.system) / 1e6 },
			]),
			gauge("process_event_loop_delay_seconds", "Worst event loop delay since the last scrape.", [
				{ labels: {}, value: Math.max(0, delay) / 1000 },
			]),
		];
	});
	return () => clearInterval(timer);
}
