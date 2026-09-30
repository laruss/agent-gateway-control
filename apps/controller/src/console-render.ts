import type { DailyBudget, SystemStatusAgent, SystemStatusQueue } from "@agent-gateway/contracts";
import type {
	ConsoleAgent,
	ConsoleAlert,
	ConsoleContext,
	ConsoleRun,
	ConsoleStatus,
	ConsoleTask,
	ConsoleWait,
} from "@agent-gateway/core";
import type { ConsoleSnapshot } from "./console-status.ts";

// ---------------------------------------------------------------------------
// The owner's console page: a pure function from a `ConsoleSnapshot` to an HTML string
// (ADR-023). No client framework, no build step, no external asset: the controller escapes
// every dynamic value itself (`escapeHtml`) and serves plain, self-contained markup. Never a
// context-window fill percentage — only the Gateway's own separate, labeled measurements.
// ---------------------------------------------------------------------------

/** Escapes one dynamic value for both HTML text and a quoted attribute. Every dynamic field the
 * page renders goes through this, even one already bounded by a Gateway-made charset upstream:
 * the page's own safety never depends on every schema staying narrow forever. */
export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

const esc = escapeHtml;
const DASH = "—";
const orDash = (value: string | null): string => (value === null ? DASH : esc(value));
const numOrDash = (value: number | null): string => (value === null ? DASH : fmt(value));
const fmt = (value: number): string => value.toLocaleString("en-US");

/** A state/status token is Gateway-made (`TokenSchema`) and safe as a CSS class name, but a
 * value this module has never seen before (a future status) falls back to a neutral class
 * rather than being used unescaped as one. */
function stateClass(state: string): string {
	return /^[a-z][a-z0-9_]*$/.test(state) ? state : "unknown";
}

const STYLE = `
:root {
	color-scheme: light dark;
	--bg: #f5f6f8; --panel: #ffffff; --text: #1a1d23; --muted: #5b6270; --border: #dde1e7;
	--accent: #2a6ef0; --ok: #1f8a4c; --warn: #b7791f; --bad: #c0392b;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #14161a; --panel: #1d2026; --text: #e7e9ee; --muted: #9aa2b1; --border: #2c303a;
		--accent: #6ea4ff; --ok: #4cbd7d; --warn: #e0a83a; --bad: #e2564f;
	}
}
* { box-sizing: border-box; }
body {
	margin: 0; padding: 1rem; background: var(--bg); color: var(--text);
	font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
h1, h2, h3 { margin: 0 0 0.5rem; }
h1 { font-size: 1.25rem; }
h2 { font-size: 0.9rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
h3 { font-size: 1rem; }
.muted { color: var(--muted); }
.banner { padding: 0.75rem 1rem; border-radius: 0.5rem; margin-bottom: 1rem; font-weight: 600; }
.banner.stale { background: var(--bg); color: var(--warn); border: 1px solid var(--warn); }
.banner.unavailable { background: var(--bg); color: var(--bad); border: 1px solid var(--bad); }
.top { display: flex; flex-wrap: wrap; gap: 0.4rem 1.25rem; margin-bottom: 1rem; font-size: 0.9rem; }
.pill {
	display: inline-block; padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.8rem;
	font-weight: 600; border: 1px solid var(--border);
}
.pill.on { color: var(--bad); border-color: var(--bad); }
.pill.off { color: var(--ok); border-color: var(--ok); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 0.75rem; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 0.6rem; padding: 0.75rem 0.9rem; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.6rem; font-size: 0.85rem; margin: 0 0 0.4rem; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; text-align: right; }
.state { font-weight: 600; }
.state.running, .state.succeeded { color: var(--ok); }
.state.failed, .state.error { color: var(--bad); }
.state.waiting, .state.queued, .state.retry { color: var(--warn); }
table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
th, td { text-align: left; padding: 0.3rem 0.5rem; border-bottom: 1px solid var(--border); white-space: nowrap; }
.scroll { overflow-x: auto; }
.meas { display: grid; grid-template-columns: 1fr auto; gap: 0.1rem 0.5rem; font-size: 0.78rem; color: var(--muted); margin-top: 0.4rem; }
.section { margin-bottom: 1.5rem; }
footer { color: var(--muted); font-size: 0.75rem; margin-top: 1.5rem; }
ul { margin: 0.2rem 0; padding-left: 1.1rem; font-size: 0.85rem; }
@media (max-width: 480px) {
	body { padding: 0.6rem; font-size: 14px; }
	.kv dd { text-align: left; }
}
`;

function pageShell(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function banner(snapshot: ConsoleSnapshot): string {
	if (snapshot.state === "ok") {
		return "";
	}
	if (snapshot.state === "stale") {
		return `<div class="banner stale">Showing data from ${esc(snapshot.asOf)} (stale) &mdash; the last refresh failed: ${esc(snapshot.error)}</div>`;
	}
	return `<div class="banner unavailable">Console data is unavailable: ${esc(snapshot.error)}</div>`;
}

function topSummary(status: ConsoleStatus): string {
	const s = status.system;
	return `<div class="top">
<span class="pill ${s.killSwitch ? "on" : "off"}">Kill switch: ${s.killSwitch ? "ON" : "off"}</span>
<span>Approvals pending: <strong>${fmt(s.approvalsPending)}</strong></span>
<span>Tool actions unknown: <strong>${fmt(s.toolActionsUnknown)}</strong></span>
<span>Outbox pending: <strong>${fmt(s.outbox.pending)}</strong> &middot; dead: <strong>${fmt(s.outbox.dead)}</strong></span>
<span>Agents omitted: <strong>${fmt(s.omittedAgents)}</strong></span>
</div>`;
}

function alertsSection(alerts: Readonly<ConsoleAlert[]>): string {
	if (alerts.length === 0) {
		return "";
	}
	const items = alerts
		.map(
			(a) =>
				`<li><strong>${esc(a.key)}</strong> since ${esc(a.firedAt)} &mdash; ${esc(a.message)}</li>`,
		)
		.join("");
	return `<section class="section"><h2>Alerts</h2><ul>${items}</ul></section>`;
}

function taskBlock(task: ConsoleTask | null): string {
	if (task === null) {
		return `<p class="muted">No current task.</p>`;
	}
	return `<dl class="kv">
<dt>Task</dt><dd class="state ${stateClass(task.status)}">${esc(task.status)} (attempt ${task.attempt}/${task.maxAttempts})</dd>
<dt>Trigger</dt><dd>${esc(task.triggerType)}</dd>
<dt>Channel</dt><dd>${orDash(task.channel)}</dd>
<dt>Thread</dt><dd>${orDash(task.threadRootId)}</dd>
<dt>Queued</dt><dd>${esc(task.queuedAt)}</dd>
<dt>Started</dt><dd>${orDash(task.startedAt)}</dd>
<dt>Deadline</dt><dd>${esc(task.deadlineAt)}</dd>
</dl>`;
}

function waitsBlock(waits: Readonly<ConsoleWait[]>): string {
	if (waits.length === 0) {
		return "";
	}
	const items = waits.map((w) => `<li>${esc(w.eventType)} until ${esc(w.timeoutAt)}</li>`).join("");
	return `<p class="muted" style="margin-bottom:0">Waits</p><ul>${items}</ul>`;
}

function contextBlock(context: ConsoleContext | null, maxInputTokens7d: number | null): string {
	if (context === null) {
		return `<div class="meas"><span>Context</span><span>${DASH}</span></div>`;
	}
	const row = (label: string, value: string) => `<span>${esc(label)}</span><span>${value}</span>`;
	return `<div class="meas">
${row("Input bytes / cap", `${fmt(context.inputBytes)} / ${fmt(context.inputLimitBytes)}`)}
${row("Recent-replies chars / budget", `${fmt(context.recentRepliesChars)} / ${fmt(context.recentRepliesLimitChars)}`)}
${row("Root chars / cap", `${fmt(context.rootChars)} / ${fmt(context.rootLimitChars)}`)}
${row("Summary chars / limit", `${fmt(context.summaryChars)} / ${fmt(context.summaryLimitChars)}`)}
${row("Memory chars / budget", `${fmt(context.memoryChars)} / ${fmt(context.memoryLimitChars)} (${fmt(context.memoryItems)} items)`)}
${row("Last attempt input tokens", numOrDash(context.inputTokens))}
${row("Last attempt cached input tokens", numOrDash(context.cachedInputTokens))}
${row("Last attempt output tokens", numOrDash(context.outputTokens))}
${row("7-day max input tokens", numOrDash(maxInputTokens7d))}
${row("Omitted thread posts", fmt(context.omittedPosts))}
${row("Pending events", fmt(context.pendingEvents))}
${row("Model", context.model === null ? DASH : esc(context.model))}
</div>`;
}

function budgetLine(tokensToday: number, costTodayUsd: number, budget: DailyBudget | null): string {
	const tokenPart =
		budget?.tokens === undefined
			? `${fmt(tokensToday)} tokens today`
			: `${fmt(tokensToday)} / ${fmt(budget.tokens)} tokens today`;
	const costPart =
		budget?.cost_usd === undefined
			? `$${costTodayUsd.toFixed(2)} today`
			: `$${costTodayUsd.toFixed(2)} / $${budget.cost_usd.toFixed(2)} today`;
	return `${tokenPart} &middot; ${costPart}`;
}

function agentHeader(
	status: SystemStatusAgent,
	displayName: string,
	budget: DailyBudget | null,
): string {
	return `<h3>${esc(displayName)} <span class="muted">(${esc(status.agentId)})</span></h3>
<dl class="kv">
<dt>State</dt><dd class="state ${stateClass(status.state)}">${esc(status.state)}${status.enabled ? "" : " (disabled)"}</dd>
<dt>Since</dt><dd>${esc(status.stateSince)}</dd>
<dt>Runtime</dt><dd>${esc(status.runtimeAdapter)}${status.model === null ? "" : ` &middot; ${esc(status.model)}`}</dd>
<dt>Budget</dt><dd>${budgetLine(status.tokensToday, status.costTodayUsd, budget)}</dd>
<dt>Pending inbox</dt><dd>${fmt(status.pendingInbox)}</dd>
</dl>`;
}

function agentCard(agent: ConsoleAgent): string {
	return `<article class="card">
${agentHeader(agent.status, agent.displayName, agent.budget)}
${taskBlock(agent.current)}
${waitsBlock(agent.waits)}
${contextBlock(agent.context, agent.maxInputTokens7d)}
</article>`;
}

function recentRunsTable(runs: Readonly<ConsoleRun[]>): string {
	if (runs.length === 0) {
		return `<p class="muted">No recent runs.</p>`;
	}
	const rows = runs
		.map(
			(r) => `<tr>
<td>${esc(r.agentId)}</td>
<td class="state ${stateClass(r.status)}">${esc(r.status)}</td>
<td>${orDash(r.outcome)}</td>
<td>${orDash(r.errorCode)}</td>
<td>${esc(r.triggerType)}</td>
<td>${esc(r.queuedAt)}</td>
<td>${orDash(r.startedAt)}</td>
<td>${orDash(r.finishedAt)}</td>
<td>${numOrDash(r.inputTokens)}</td>
<td>${numOrDash(r.outputTokens)}</td>
</tr>`,
		)
		.join("");
	return `<div class="scroll"><table>
<thead><tr><th>Agent</th><th>Status</th><th>Outcome</th><th>Error</th><th>Trigger</th><th>Queued</th><th>Started</th><th>Finished</th><th>In tok</th><th>Out tok</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

function queuesTable(queues: Readonly<SystemStatusQueue[]>): string {
	if (queues.length === 0) {
		return `<p class="muted">No queue backlog.</p>`;
	}
	const rows = queues
		.map(
			(q) => `<tr>
<td>${esc(q.queue)}${q.queue.startsWith("dlq.") ? ' <span class="pill on">DLQ</span>' : ""}</td>
<td>${fmt(q.waiting)}</td>
<td>${fmt(q.active)}</td>
<td>${q.oldestWaitingSeconds === null ? DASH : `${fmt(Math.round(q.oldestWaitingSeconds))}s`}</td>
</tr>`,
		)
		.join("");
	return `<div class="scroll"><table>
<thead><tr><th>Queue</th><th>Waiting</th><th>Active</th><th>Oldest wait</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

function footerLine(status: ConsoleStatus): string {
	const runtimes = status.system.runtimes
		.map((r) => `${esc(r.adapter)}: ${r.available ? "available" : "unavailable"}`)
		.join(" &middot; ");
	const maintenance = status.system.maintenance
		.map((m) => `${esc(m.task)}: ${m.lastSuccessAt === null ? "never" : esc(m.lastSuccessAt)}`)
		.join(" &middot; ");
	const lines = [
		runtimes === "" ? "" : `Runtimes: ${runtimes}`,
		maintenance === "" ? "" : `Maintenance: ${maintenance}`,
	].filter((line) => line !== "");
	return lines.length === 0 ? "" : `<footer>${lines.join("<br>")}</footer>`;
}

const TITLE = "Agent Gateway Console";

/** Renders the console's one page: the full dashboard when data is available (even if stale),
 * or a minimal unavailable page before any collection has ever succeeded. Pure: every dynamic
 * value is escaped, nothing here performs IO. */
export function renderConsolePage(snapshot: ConsoleSnapshot): string {
	if (snapshot.state === "unavailable") {
		return pageShell(
			TITLE,
			`<h1>${esc(TITLE)}</h1>${banner(snapshot)}<p>No console data has been collected yet.</p>`,
		);
	}
	const { status } = snapshot;
	const body = `<h1>${esc(TITLE)}</h1>
<p class="muted">As of ${esc(snapshot.asOf)}</p>
${banner(snapshot)}
${topSummary(status)}
${alertsSection(status.alerts)}
<section class="section"><h2>Agents</h2>${
		status.agents.length === 0
			? `<p class="muted">No agents configured.</p>`
			: `<div class="grid">${status.agents.map(agentCard).join("")}</div>`
	}</section>
<section class="section"><h2>Recent runs</h2>${recentRunsTable(status.recentRuns)}</section>
<section class="section"><h2>Queues</h2>${queuesTable(status.system.queues)}</section>
${footerLine(status)}`;
	return pageShell(TITLE, body);
}
