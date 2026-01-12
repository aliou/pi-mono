/**
 * Simple ANSI to HTML converter for export.
 *
 * Handles the common ANSI escape codes used by TUI components:
 * - Foreground colors (30-37, 90-97, 38;5;N, 38;2;R;G;B)
 * - Background colors (40-47, 100-107, 48;5;N, 48;2;R;G;B)
 * - Bold, italic, underline, dim
 * - Reset codes
 */

/** ANSI 256-color palette (first 16 colors - standard + bright) */
const ANSI_COLORS_16: Record<number, string> = {
	0: "#000000", // Black
	1: "#cd0000", // Red
	2: "#00cd00", // Green
	3: "#cdcd00", // Yellow
	4: "#0000ee", // Blue
	5: "#cd00cd", // Magenta
	6: "#00cdcd", // Cyan
	7: "#e5e5e5", // White
	8: "#7f7f7f", // Bright Black
	9: "#ff0000", // Bright Red
	10: "#00ff00", // Bright Green
	11: "#ffff00", // Bright Yellow
	12: "#5c5cff", // Bright Blue
	13: "#ff00ff", // Bright Magenta
	14: "#00ffff", // Bright Cyan
	15: "#ffffff", // Bright White
};

/**
 * Convert 256-color index to hex color.
 */
function ansi256ToHex(code: number): string {
	if (code < 16) {
		return ANSI_COLORS_16[code] || "#ffffff";
	}
	if (code < 232) {
		// 216 colors (6x6x6 cube)
		const n = code - 16;
		const r = Math.floor(n / 36);
		const g = Math.floor((n % 36) / 6);
		const b = n % 6;
		const toHex = (c: number) => (c === 0 ? 0 : 55 + c * 40).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}
	// 24 grayscale colors
	const gray = (code - 232) * 10 + 8;
	const hex = gray.toString(16).padStart(2, "0");
	return `#${hex}${hex}${hex}`;
}

interface StyleState {
	fg?: string;
	bg?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	dim?: boolean;
}

/**
 * Convert ANSI-escaped text to HTML.
 * @param text Text containing ANSI escape codes
 * @returns HTML string with inline styles
 */
export function ansiToHtml(text: string): string {
	// eslint-disable-next-line no-control-regex
	const ansiRegex = /\x1b\[([0-9;]*)m/g;
	const state: StyleState = {};
	let result = "";
	let lastIndex = 0;

	const openSpan = (): string => {
		const styles: string[] = [];
		if (state.fg) styles.push(`color:${state.fg}`);
		if (state.bg) styles.push(`background-color:${state.bg}`);
		if (state.bold) styles.push("font-weight:bold");
		if (state.italic) styles.push("font-style:italic");
		if (state.underline) styles.push("text-decoration:underline");
		if (state.dim) styles.push("opacity:0.6");
		return styles.length > 0 ? `<span style="${styles.join(";")}">` : "";
	};

	const hasStyle = (): boolean =>
		!!(state.fg || state.bg || state.bold || state.italic || state.underline || state.dim);

	const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

	// Use matchAll to avoid assignment in while condition
	for (const match of text.matchAll(ansiRegex)) {
		// Append text before this match
		const before = text.slice(lastIndex, match.index);
		if (before) {
			if (hasStyle()) {
				result += `${openSpan()}${escapeHtml(before)}</span>`;
			} else {
				result += escapeHtml(before);
			}
		}

		// Parse codes
		const codes = match[1].split(";").map((s) => (s === "" ? 0 : Number.parseInt(s, 10)));
		let i = 0;
		while (i < codes.length) {
			const code = codes[i];

			if (code === 0) {
				// Reset
				state.fg = undefined;
				state.bg = undefined;
				state.bold = undefined;
				state.italic = undefined;
				state.underline = undefined;
				state.dim = undefined;
			} else if (code === 1) {
				state.bold = true;
			} else if (code === 2) {
				state.dim = true;
			} else if (code === 3) {
				state.italic = true;
			} else if (code === 4) {
				state.underline = true;
			} else if (code === 22) {
				state.bold = undefined;
				state.dim = undefined;
			} else if (code === 23) {
				state.italic = undefined;
			} else if (code === 24) {
				state.underline = undefined;
			} else if (code >= 30 && code <= 37) {
				// Standard foreground
				state.fg = ANSI_COLORS_16[code - 30];
			} else if (code === 38) {
				// Extended foreground
				if (codes[i + 1] === 5 && codes[i + 2] !== undefined) {
					state.fg = ansi256ToHex(codes[i + 2]);
					i += 2;
				} else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) {
					const r = codes[i + 2];
					const g = codes[i + 3];
					const b = codes[i + 4];
					state.fg = `rgb(${r},${g},${b})`;
					i += 4;
				}
			} else if (code === 39) {
				state.fg = undefined;
			} else if (code >= 40 && code <= 47) {
				// Standard background
				state.bg = ANSI_COLORS_16[code - 40];
			} else if (code === 48) {
				// Extended background
				if (codes[i + 1] === 5 && codes[i + 2] !== undefined) {
					state.bg = ansi256ToHex(codes[i + 2]);
					i += 2;
				} else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) {
					const r = codes[i + 2];
					const g = codes[i + 3];
					const b = codes[i + 4];
					state.bg = `rgb(${r},${g},${b})`;
					i += 4;
				}
			} else if (code === 49) {
				state.bg = undefined;
			} else if (code >= 90 && code <= 97) {
				// Bright foreground
				state.fg = ANSI_COLORS_16[code - 90 + 8];
			} else if (code >= 100 && code <= 107) {
				// Bright background
				state.bg = ANSI_COLORS_16[code - 100 + 8];
			}

			i++;
		}

		lastIndex = (match.index ?? 0) + match[0].length;
	}

	// Append remaining text
	const remaining = text.slice(lastIndex);
	if (remaining) {
		if (hasStyle()) {
			result += `${openSpan()}${escapeHtml(remaining)}</span>`;
		} else {
			result += escapeHtml(remaining);
		}
	}

	return result;
}

/**
 * Convert array of ANSI lines to HTML.
 * @param lines Array of lines (output from Component.render())
 * @returns HTML string
 */
export function ansiLinesToHtml(lines: string[]): string {
	return lines.map(ansiToHtml).join("<br>");
}
