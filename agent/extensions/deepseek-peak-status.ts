/**
 * DeepSeek Peak-Hour Indicator
 *
 * Shows a live footer status while a DeepSeek model is active:
 *   - Peak:     ● DeepSeek V4 Flash peak · until 11:00 UTC+7
 *   - Off-peak: ○ DeepSeek V4 Flash off-peak · 21:05 UTC+7
 *
 * Peak windows (UTC, weekdays only — all other times are off-peak):
 *   Mon-Fri 01:00-04:00 and 06:00-10:00
 *
 * The clock text in the footer is shown in UTC+7; peak/off-peak detection
 * itself stays based on the UTC windows above.
 *
 * Boundaries are half-open: 04:00 and 10:00 UTC exactly are off-peak.
 * The indicator appears only for DeepSeek models and clears when the
 * model is switched to another provider. The status refreshes every
 * few seconds so it stays accurate when a session crosses a boundary.
 *
 * Usage: global extension at ~/.pi/agent/extensions/, auto-loaded.
 * Reload with /reload or restart pi.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "deepseek-peak";
const REFRESH_MS = 10_000; // poll interval; re-renders only when the text changes

// Offset of the clock displayed in the footer (peak windows themselves stay
// defined in UTC: 01:00-04:00 & 06:00-10:00 UTC, Mon-Fri).
const DISPLAY_OFFSET_HOURS = 7;

// Peak windows as [startHour, endHour) in UTC. Weekdays only (Mon-Fri).
const PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
	[1, 4], // 01:00 - 04:00
	[6, 10], // 06:00 - 10:00
];

interface ModelLike {
	provider?: string;
	id?: string;
}

function isWeekdayUtc(now: Date): boolean {
	const day = now.getUTCDay(); // 0 = Sunday ... 6 = Saturday
	return day >= 1 && day <= 5;
}

function currentPeakState(now: Date): { peak: boolean; endsAtHour: number | null } {
	if (isWeekdayUtc(now)) {
		const hourUtc = now.getUTCHours();
		for (const [start, end] of PEAK_WINDOWS) {
			if (hourUtc >= start && hourUtc < end) {
				return { peak: true, endsAtHour: end };
			}
		}
	}
	return { peak: false, endsAtHour: null };
}

/** Return the current clock time in the display timezone (UTC+7). */
function fmtDisplayTime(now: Date): string {
	const shifted = new Date(now.getTime() + DISPLAY_OFFSET_HOURS * 60 * 60 * 1000);
	const h = String(shifted.getUTCHours()).padStart(2, "0");
	const m = String(shifted.getUTCMinutes()).padStart(2, "0");
	return `${h}:${m} UTC+${DISPLAY_OFFSET_HOURS}`;
}

function isDeepseek(model: ModelLike | null | undefined): model is ModelLike {
	return !!model && model.provider === "deepseek";
}

/** "deepseek-v4-flash" or name "DeepSeek V4 Flash" -> "V4 Flash" */
function modelLabel(model: ModelLike): string {
	const name = (model as ModelLike & { name?: unknown }).name;
	if (typeof name === "string" && name.trim()) {
		return name.replace(/^deepseek\s+/i, "").trim() || model.id || name;
	}
	const parts = (model.id || "").replace(/^deepseek-/, "").split("-");
	return parts
		.filter(Boolean)
		.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
		.join(" ");
}

function buildStatus(ctx: ExtensionContext, model: ModelLike, now: Date): string {
	const theme = ctx.ui.theme;
	const state = currentPeakState(now);
	const modelText = theme.fg("muted", `DeepSeek ${modelLabel(model)}`);

	if (state.peak && state.endsAtHour !== null) {
		const endLocal = (state.endsAtHour + DISPLAY_OFFSET_HOURS) % 24; // UTC end hour -> UTC+7 clock
		const end = `${String(endLocal).padStart(2, "0")}:00 UTC+${DISPLAY_OFFSET_HOURS}`;
		const marker = theme.fg("warning", "● peak");
		return `${marker} ${modelText} ${theme.fg("dim", `· until ${end}`)}`;
	}
	const marker = theme.fg("success", "○ off-peak");
	return `${marker} ${modelText} ${theme.fg("dim", `· ${fmtDisplayTime(now)}`)}`;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let activeCtx: ExtensionContext | null = null;
	let lastText: string | null = null;

	/** Recompute and update the footer status. Skips work if nothing changed. */
	function refresh() {
		const ctx = activeCtx;
		const model = ctx?.model;
		if (!ctx || !isDeepseek(model)) return;
		const text = buildStatus(ctx, model, new Date());
		if (text !== lastText) {
			lastText = text;
			ctx.ui.setStatus(STATUS_KEY, text);
		}
	}

	/** Clear the footer status (non-DeepSeek model active). */
	function clear() {
		lastText = null;
		if (activeCtx) activeCtx.ui.setStatus(STATUS_KEY, undefined);
	}

	function ensureTimer() {
		if (!timer) timer = setInterval(refresh, REFRESH_MS);
	}

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		refresh();
		ensureTimer();
	});

	pi.on("model_select", async (_event, ctx) => {
		activeCtx = ctx;
		if (isDeepseek(ctx.model)) {
			refresh();
			ensureTimer();
		} else {
			clear();
		}
	});

	pi.on("session_shutdown", () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		activeCtx = null;
		lastText = null;
	});
}
