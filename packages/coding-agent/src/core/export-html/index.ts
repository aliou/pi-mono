import type { AgentState, AgentTool } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@mariozechner/pi-ai";
import { buildCodexPiBridge, getCodexInstructions } from "@mariozechner/pi-ai";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { APP_NAME, getExportTemplateDir } from "../../config.js";
import { getResolvedThemeColors, getThemeExportColors } from "../../modes/interactive/theme/theme.js";
import type { SessionMessageEntry } from "../session-manager.js";
import { SessionManager } from "../session-manager.js";

/** Built-in tool names that have custom rendering in template.js */
const BUILTIN_TOOLS = new Set(["bash", "read", "write", "edit", "ls", "find", "grep"]);

/**
 * Renderer interface for custom tool HTML generation.
 * Implementations convert tool calls/results to HTML for export.
 */
export interface ToolHtmlRenderer {
	/**
	 * Render a tool call to HTML.
	 * @param toolName Name of the tool
	 * @param args Tool arguments
	 * @param toolCallId The tool call ID (for looking up results)
	 * @returns HTML string, or undefined to use default JSON rendering
	 */
	renderCall(toolName: string, args: unknown, toolCallId: string): string | undefined;

	/**
	 * Render a tool result to HTML.
	 * @param toolName Name of the tool
	 * @param result Tool result content
	 * @param details Tool result details
	 * @param isError Whether the result is an error
	 * @param expanded Whether to render the expanded version
	 * @returns HTML string, or undefined to use default rendering
	 */
	renderResult(
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
		expanded: boolean,
	): string | undefined;
}

export interface ExportOptions {
	outputPath?: string;
	themeName?: string;
	/** Optional renderer for custom tool HTML generation */
	toolRenderer?: ToolHtmlRenderer;
}

/** Info about Codex injection to show inline with model_change entries */
interface CodexInjectionInfo {
	/** Codex instructions text */
	instructions: string;
	/** Bridge text (tool list) */
	bridge: string;
}

/**
 * Build Codex injection info for display inline with model_change entries.
 */
async function buildCodexInjectionInfo(tools?: AgentTool[]): Promise<CodexInjectionInfo | undefined> {
	// Try to get cached instructions for default model family
	let instructions: string | null = null;
	try {
		instructions = getCodexInstructions();
	} catch {
		// Cache miss - that's fine
	}

	const bridgeText = buildCodexPiBridge(tools);

	const instructionsText =
		instructions || "(Codex instructions not cached. Run a Codex request to populate the local cache.)";

	return {
		instructions: instructionsText,
		bridge: bridgeText,
	};
}

/** Parse a color string to RGB values. Supports hex (#RRGGBB) and rgb(r,g,b) formats. */
function parseColor(color: string): { r: number; g: number; b: number } | undefined {
	const hexMatch = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (hexMatch) {
		return {
			r: Number.parseInt(hexMatch[1], 16),
			g: Number.parseInt(hexMatch[2], 16),
			b: Number.parseInt(hexMatch[3], 16),
		};
	}
	const rgbMatch = color.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
	if (rgbMatch) {
		return {
			r: Number.parseInt(rgbMatch[1], 10),
			g: Number.parseInt(rgbMatch[2], 10),
			b: Number.parseInt(rgbMatch[3], 10),
		};
	}
	return undefined;
}

/** Calculate relative luminance of a color (0-1, higher = lighter). */
function getLuminance(r: number, g: number, b: number): number {
	const toLinear = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Adjust color brightness. Factor > 1 lightens, < 1 darkens. */
function adjustBrightness(color: string, factor: number): string {
	const parsed = parseColor(color);
	if (!parsed) return color;
	const adjust = (c: number) => Math.min(255, Math.max(0, Math.round(c * factor)));
	return `rgb(${adjust(parsed.r)}, ${adjust(parsed.g)}, ${adjust(parsed.b)})`;
}

/** Derive export background colors from a base color (e.g., userMessageBg). */
function deriveExportColors(baseColor: string): { pageBg: string; cardBg: string; infoBg: string } {
	const parsed = parseColor(baseColor);
	if (!parsed) {
		return {
			pageBg: "rgb(24, 24, 30)",
			cardBg: "rgb(30, 30, 36)",
			infoBg: "rgb(60, 55, 40)",
		};
	}

	const luminance = getLuminance(parsed.r, parsed.g, parsed.b);
	const isLight = luminance > 0.5;

	if (isLight) {
		return {
			pageBg: adjustBrightness(baseColor, 0.96),
			cardBg: baseColor,
			infoBg: `rgb(${Math.min(255, parsed.r + 10)}, ${Math.min(255, parsed.g + 5)}, ${Math.max(0, parsed.b - 20)})`,
		};
	}
	return {
		pageBg: adjustBrightness(baseColor, 0.7),
		cardBg: adjustBrightness(baseColor, 0.85),
		infoBg: `rgb(${Math.min(255, parsed.r + 20)}, ${Math.min(255, parsed.g + 15)}, ${parsed.b})`,
	};
}

/**
 * Generate CSS custom property declarations from theme colors.
 */
function generateThemeVars(themeName?: string): string {
	const colors = getResolvedThemeColors(themeName);
	const lines: string[] = [];
	for (const [key, value] of Object.entries(colors)) {
		lines.push(`--${key}: ${value};`);
	}

	// Use explicit theme export colors if available, otherwise derive from userMessageBg
	const themeExport = getThemeExportColors(themeName);
	const userMessageBg = colors.userMessageBg || "#343541";
	const derivedColors = deriveExportColors(userMessageBg);

	lines.push(`--exportPageBg: ${themeExport.pageBg ?? derivedColors.pageBg};`);
	lines.push(`--exportCardBg: ${themeExport.cardBg ?? derivedColors.cardBg};`);
	lines.push(`--exportInfoBg: ${themeExport.infoBg ?? derivedColors.infoBg};`);

	return lines.join("\n      ");
}

/** Pre-rendered HTML for a tool call */
interface RenderedToolHtml {
	/** HTML for the tool call header/args */
	callHtml?: string;
	/** HTML for the tool result (collapsed view) */
	resultHtmlCollapsed?: string;
	/** HTML for the tool result (expanded view) */
	resultHtmlExpanded?: string;
}

interface SessionData {
	header: ReturnType<SessionManager["getHeader"]>;
	entries: ReturnType<SessionManager["getEntries"]>;
	leafId: string | null;
	systemPrompt?: string;
	/** Info for rendering Codex injection inline with model_change entries */
	codexInjectionInfo?: CodexInjectionInfo;
	tools?: { name: string; description: string }[];
	/** Pre-rendered HTML for custom tool calls, keyed by toolCallId */
	renderedTools?: Record<string, RenderedToolHtml>;
}

/**
 * Build a map from toolCallId to tool result for quick lookup.
 */
function buildToolResultMap(entries: ReturnType<SessionManager["getEntries"]>): Map<
	string,
	{
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: unknown;
		isError: boolean;
	}
> {
	const map = new Map<
		string,
		{
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: unknown;
			isError: boolean;
		}
	>();
	for (const entry of entries) {
		if (entry.type === "message") {
			const msg = (entry as SessionMessageEntry).message;
			if (msg.role === "toolResult") {
				map.set(msg.toolCallId, {
					content: msg.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
					details: (msg as { details?: unknown }).details,
					isError: msg.isError ?? false,
				});
			}
		}
	}
	return map;
}

/**
 * Pre-render custom tool calls using the provided renderer.
 * Only renders tools that are not built-in (don't have special rendering in template.js).
 */
function renderCustomTools(
	entries: ReturnType<SessionManager["getEntries"]>,
	renderer: ToolHtmlRenderer,
): Record<string, RenderedToolHtml> {
	const renderedTools: Record<string, RenderedToolHtml> = {};
	const toolResults = buildToolResultMap(entries);

	for (const entry of entries) {
		if (entry.type === "message") {
			const msg = (entry as SessionMessageEntry).message;
			if (msg.role === "assistant") {
				const assistantMsg = msg as AssistantMessage;
				for (const block of assistantMsg.content) {
					if (block.type === "toolCall") {
						const toolCall = block as ToolCall;
						// Only render custom tools (not built-in ones)
						if (!BUILTIN_TOOLS.has(toolCall.name)) {
							const rendered: RenderedToolHtml = {};

							// Render call
							const callHtml = renderer.renderCall(toolCall.name, toolCall.arguments, toolCall.id);
							if (callHtml) {
								rendered.callHtml = callHtml;
							}

							// Render result if available (both collapsed and expanded)
							const result = toolResults.get(toolCall.id);
							if (result) {
								const collapsedHtml = renderer.renderResult(
									toolCall.name,
									result.content,
									result.details,
									result.isError,
									false,
								);
								const expandedHtml = renderer.renderResult(
									toolCall.name,
									result.content,
									result.details,
									result.isError,
									true,
								);
								if (collapsedHtml) {
									rendered.resultHtmlCollapsed = collapsedHtml;
								}
								if (expandedHtml) {
									rendered.resultHtmlExpanded = expandedHtml;
								}
							}

							if (rendered.callHtml || rendered.resultHtmlCollapsed || rendered.resultHtmlExpanded) {
								renderedTools[toolCall.id] = rendered;
							}
						}
					}
				}
			}
		}
	}

	return renderedTools;
}

/**
 * Core HTML generation logic shared by both export functions.
 */
function generateHtml(sessionData: SessionData, themeName?: string): string {
	const templateDir = getExportTemplateDir();
	const template = readFileSync(join(templateDir, "template.html"), "utf-8");
	const templateCss = readFileSync(join(templateDir, "template.css"), "utf-8");
	const templateJs = readFileSync(join(templateDir, "template.js"), "utf-8");
	const markedJs = readFileSync(join(templateDir, "vendor", "marked.min.js"), "utf-8");
	const hljsJs = readFileSync(join(templateDir, "vendor", "highlight.min.js"), "utf-8");

	const themeVars = generateThemeVars(themeName);
	const colors = getResolvedThemeColors(themeName);
	const exportColors = deriveExportColors(colors.userMessageBg || "#343541");
	const bodyBg = exportColors.pageBg;
	const containerBg = exportColors.cardBg;
	const infoBg = exportColors.infoBg;

	// Base64 encode session data to avoid escaping issues
	const sessionDataBase64 = Buffer.from(JSON.stringify(sessionData)).toString("base64");

	// Build the CSS with theme variables injected
	const css = templateCss
		.replace("{{THEME_VARS}}", themeVars)
		.replace("{{BODY_BG}}", bodyBg)
		.replace("{{CONTAINER_BG}}", containerBg)
		.replace("{{INFO_BG}}", infoBg);

	return template
		.replace("{{CSS}}", css)
		.replace("{{JS}}", templateJs)
		.replace("{{SESSION_DATA}}", sessionDataBase64)
		.replace("{{MARKED_JS}}", markedJs)
		.replace("{{HIGHLIGHT_JS}}", hljsJs);
}

/**
 * Export session to HTML using SessionManager and AgentState.
 * Used by TUI's /export command.
 */
export async function exportSessionToHtml(
	sm: SessionManager,
	state?: AgentState,
	options?: ExportOptions | string,
): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};

	const sessionFile = sm.getSessionFile();
	if (!sessionFile) {
		throw new Error("Cannot export in-memory session to HTML");
	}
	if (!existsSync(sessionFile)) {
		throw new Error("Nothing to export yet - start a conversation first");
	}

	const entries = sm.getEntries();

	// Pre-render custom tools if a renderer is provided
	const renderedTools = opts.toolRenderer ? renderCustomTools(entries, opts.toolRenderer) : undefined;

	const sessionData: SessionData = {
		header: sm.getHeader(),
		entries,
		leafId: sm.getLeafId(),
		systemPrompt: state?.systemPrompt,
		codexInjectionInfo: await buildCodexInjectionInfo(state?.tools),
		tools: state?.tools?.map((t) => ({ name: t.name, description: t.description })),
		renderedTools,
	};

	const html = generateHtml(sessionData, opts.themeName);

	let outputPath = opts.outputPath;
	if (!outputPath) {
		const sessionBasename = basename(sessionFile, ".jsonl");
		outputPath = `${APP_NAME}-session-${sessionBasename}.html`;
	}

	writeFileSync(outputPath, html, "utf8");
	return outputPath;
}

/**
 * Export session file to HTML (standalone, without AgentState).
 * Used by CLI for exporting arbitrary session files.
 */
export async function exportFromFile(inputPath: string, options?: ExportOptions | string): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};

	if (!existsSync(inputPath)) {
		throw new Error(`File not found: ${inputPath}`);
	}

	const sm = SessionManager.open(inputPath);

	const sessionData: SessionData = {
		header: sm.getHeader(),
		entries: sm.getEntries(),
		leafId: sm.getLeafId(),
		systemPrompt: undefined,
		codexInjectionInfo: await buildCodexInjectionInfo(undefined),
		tools: undefined,
	};

	const html = generateHtml(sessionData, opts.themeName);

	let outputPath = opts.outputPath;
	if (!outputPath) {
		const inputBasename = basename(inputPath, ".jsonl");
		outputPath = `${APP_NAME}-session-${inputBasename}.html`;
	}

	writeFileSync(outputPath, html, "utf8");
	return outputPath;
}
