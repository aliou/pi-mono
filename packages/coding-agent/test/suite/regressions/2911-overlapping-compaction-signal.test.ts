/**
 * Regression test for issue #2911
 * Compaction can fail with "Cannot read properties of undefined (reading 'signal')"
 * when compactions overlap.
 *
 * The bug: both compact() and _runAutoCompaction() stored their AbortController on
 * shared instance fields. If two compactions of the same kind overlap, the second one
 * replaces the shared field, and when the first one's finally block sets it to
 * undefined, the second one reads undefined and crashes on .signal.
 */

import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.js";

type SessionWithCompactionInternals = {
	_compactionCancelController: AbortController | undefined;
	_activeCompactionControllers: Set<AbortController>;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
};

/**
 * Create a slow compaction extension that takes time to complete,
 * allowing overlapping compactions to be triggered.
 */
function slowCompactionExtension(delayMs: number) {
	return (pi: unknown) => {
		const api = pi as {
			on: (
				event: string,
				handler: (event: {
					preparation: { firstKeptEntryId: string; tokensBefore: number };
					signal: AbortSignal;
				}) => Promise<unknown>,
			) => void;
		};
		api.on("session_before_compact", async (event) => {
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(resolve, delayMs);
				event.signal.addEventListener("abort", () => {
					clearTimeout(timeout);
					resolve();
				});
			});
			if (event.signal.aborted) return { cancel: true as const };
			return {
				compaction: {
					summary: "slow extension compact",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: { source: "slow-extension" },
				},
			};
		});
	};
}

describe("issue #2911 overlapping compaction signal", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("does not crash when two manual compactions overlap", async () => {
		// Use a slow extension so the first compact() is still in-flight
		// when we trigger a second compact().
		const harness = await createHarness({
			extensionFactories: [slowCompactionExtension(200)],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		// Start first compact - it will take 200ms due to slow extension
		const firstCompact = harness.session.compact();

		// Let the first compact get past the abort controller creation
		await new Promise((resolve) => setTimeout(resolve, 10));

		// The first compact is still running. Start a second compact.
		// Both compactions should share the cancel-all signal and keep
		// their own local controllers until they finish.
		const secondCompact = harness.session.compact();

		// Both should settle without "Cannot read properties of undefined (reading 'signal')"
		const results = await Promise.allSettled([firstCompact, secondCompact]);

		// At least one should succeed (the second one)
		const successes = results.filter((r) => r.status === "fulfilled");
		expect(successes.length).toBeGreaterThanOrEqual(1);

		// Neither should fail with the signal bug
		for (const result of results) {
			if (result.status === "rejected") {
				const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
				expect(message).not.toContain("Cannot read properties of undefined");
			}
		}

		// After both settle, compaction state should be cleared
		const internals = harness.session as unknown as SessionWithCompactionInternals;
		expect(internals._compactionCancelController).toBeUndefined();
		expect(internals._activeCompactionControllers.size).toBe(0);
	});

	it("does not crash when manual and auto compactions overlap", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			extensionFactories: [slowCompactionExtension(200)],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		// Trigger auto-compaction via the internal method
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const autoCompactPromise = sessionInternals._runAutoCompaction("threshold", false);

		// Let it get started
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Now also trigger a manual compact while auto is running
		const manualCompactPromise = harness.session.compact();

		// Both should settle
		const results = await Promise.allSettled([autoCompactPromise, manualCompactPromise]);

		for (const result of results) {
			if (result.status === "rejected") {
				const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
				expect(message).not.toContain("Cannot read properties of undefined");
			}
		}

		// Shared compaction state should be cleared
		expect(sessionInternals._compactionCancelController).toBeUndefined();
		expect(sessionInternals._activeCompactionControllers.size).toBe(0);
	});

	it("skips second auto compaction when one is already running", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			extensionFactories: [slowCompactionExtension(200)],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		// Clear events so we only count from the two _runAutoCompaction calls
		harness.events.length = 0;

		// Start first auto-compaction
		const first = sessionInternals._runAutoCompaction("threshold", false);

		// Let it get past controller creation
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Start second auto-compaction while first is still running.
		// It should skip because one is already in progress.
		const second = sessionInternals._runAutoCompaction("threshold", false);

		// Both should settle
		await Promise.allSettled([first, second]);

		// The second auto-compaction should have been skipped —
		// only one compaction_start event should have been emitted for this pair.
		const startEvents = harness.eventsOfType("compaction_start");
		expect(startEvents).toHaveLength(1);

		// And only one compaction_end event
		const endEvents = harness.eventsOfType("compaction_end");
		expect(endEvents).toHaveLength(1);

		// Shared compaction state should be cleared after both settle
		expect(sessionInternals._compactionCancelController).toBeUndefined();
		expect(sessionInternals._activeCompactionControllers.size).toBe(0);
	});
});
