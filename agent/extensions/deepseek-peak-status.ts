/**
 * DeepSeek Peak-Hour Indicator
 *
 * Shows a live footer status while a DeepSeek model is active:
 *   - Peak:     peak 1h 23m left
 *   - Off-peak: off-peak 2h 5m left
 *
 * Peak windows (UTC, weekdays only — all other times are off-peak):
 *   Mon-Fri 01:00-04:00 and 06:00-10:00
 *
 * The time text shows how long is left in the current state: during peak,
 * until off-peak starts; during off-peak, until the next peak starts.
 *
 * Boundaries are half-open: 04:00 and 10:00 UTC exactly are off-peak.
 *
 * The indicator uses ctx.ui.setStatus(), so the built-in footer stays
 * untouched. It shows on its own line below the stats. It appears only for
 * DeepSeek models and clears when the model is switched to another provider.
 * The text refreshes every few seconds so it stays accurate when a session
 * crosses a boundary or the minute changes.
 *
 * Usage: global extension at ~/.pi/agent/extensions/, auto-loaded.
 * Reload with /reload or restart pi.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "deepseek-peak";
const REFRESH_MS = 10_000; // poll interval; re-renders only when the text changes

// Peak windows as [startHour, endHour) in UTC. Weekdays only (Mon-Fri).
const PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
	[1, 4], // 01:00 - 04:00
	[6, 10], // 06:00 - 10:00
];

interface ModelLike {
	provider?: string;
}

function isWeekdayUtc(now: Date): boolean {
	const day = now.getUTCDay(); // 0 = Sunday ... 6 = Saturday
	return day >= 1 && day <= 5;
}

/** Current peak state; endsAt is the exact UTC instant the peak ends. */
function currentPeakState(now: Date): { peak: boolean; endsAt: Date | null } {
	if (isWeekdayUtc(now)) {
		const hourUtc = now.getUTCHours();
		for (const [start, end] of PEAK_WINDOWS) {
			if (hourUtc >= start && hourUtc < end) {
				const endsAt = new Date(
					Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), end, 0, 0, 0),
				);
				return { peak: true, endsAt };
			}
		}
	}
	return { peak: false, endsAt: null };
}

/** The next peak start strictly after `now` (weekdays only). */
function nextPeakStart(now: Date): Date {
	const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	for (let i = 0; i < 8; i++) {
		const day = cursor.getUTCDay();
		if (day >= 1 && day <= 5) {
			for (const [start] of PEAK_WINDOWS) {
				const candidate = new Date(cursor.getTime() + start * 60 * 60 * 1000);
				if (candidate.getTime() > now.getTime()) return candidate;
			}
		}
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return now;
}

/** "1h 23m" / "45m" — hours and minutes left until `target`. */
function fmtRemaining(target: Date, now: Date): string {
	const ms = Math.max(0, target.getTime() - now.getTime());
	const totalMinutes = Math.floor(ms / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function isDeepseek(model: ModelLike | null | undefined): boolean {
	return !!model && model.provider === "deepseek";
}

/** Indicator text, in the same dim style as the footer. */
function buildStatus(theme: Theme, now: Date): string {
	const state = currentPeakState(now);
	const remaining =
		state.peak && state.endsAt
			? fmtRemaining(state.endsAt, now)
			: fmtRemaining(nextPeakStart(now), now);
	const label = state.peak ? "peak" : "off-peak";
	return theme.fg("dim", `${label} ${remaining} left`);
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
		const text = buildStatus(ctx.ui.theme, new Date());
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
