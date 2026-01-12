/**
 * Tool HTML renderer for export.
 *
 * Creates a renderer that converts custom tool calls/results to HTML
 * using their TUI component renderers.
 */

import type { Component } from "@mariozechner/pi-tui";
import { theme } from "../../modes/interactive/theme/theme.js";
import type { ExtensionRunner } from "../extensions/runner.js";
import type { ToolDefinition } from "../extensions/types.js";
import { ansiLinesToHtml } from "./ansi-to-html.js";
import type { ToolHtmlRenderer } from "./index.js";

/** Default width for rendering TUI components */
const DEFAULT_RENDER_WIDTH = 100;

/**
 * Render a TUI component to HTML.
 */
function renderComponentToHtml(component: Component, width: number = DEFAULT_RENDER_WIDTH): string {
	const lines = component.render(width);
	return ansiLinesToHtml(lines);
}

/**
 * Create a ToolHtmlRenderer that uses extension tool definitions.
 *
 * @param extensionRunner The extension runner to get tool definitions from
 * @returns A renderer that converts custom tool calls/results to HTML
 */
export function createToolHtmlRenderer(extensionRunner: ExtensionRunner): ToolHtmlRenderer {
	// Cache tool definitions for performance
	const toolDefinitions = new Map<string, ToolDefinition>();

	const getToolDefinition = (toolName: string): ToolDefinition | undefined => {
		if (toolDefinitions.has(toolName)) {
			return toolDefinitions.get(toolName);
		}
		const def = extensionRunner.getToolDefinition(toolName);
		if (def) {
			toolDefinitions.set(toolName, def);
		}
		return def;
	};

	return {
		renderCall(toolName: string, args: unknown, _toolCallId: string): string | undefined {
			const def = getToolDefinition(toolName);
			if (!def?.renderCall) {
				return undefined;
			}

			try {
				const component = def.renderCall(args, theme);
				if (!component) {
					return undefined;
				}
				return renderComponentToHtml(component);
			} catch {
				// Fall back to default rendering on error
				return undefined;
			}
		},

		renderResult(
			toolName: string,
			result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
			details: unknown,
			_isError: boolean,
			expanded: boolean,
		): string | undefined {
			const def = getToolDefinition(toolName);
			if (!def?.renderResult) {
				return undefined;
			}

			try {
				const component = def.renderResult(
					{ content: result as any, details },
					{ expanded, isPartial: false },
					theme,
				);
				if (!component) {
					return undefined;
				}
				return renderComponentToHtml(component);
			} catch {
				// Fall back to default rendering on error
				return undefined;
			}
		},
	};
}
