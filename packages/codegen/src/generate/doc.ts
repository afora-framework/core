/**
 * A small document printer in the style of Prettier and Biome: a `group`
 * prints on one line when it fits in 80 columns and breaks otherwise. Only
 * what the generator needs.
 */
export type Doc =
	| string
	| readonly Doc[]
	| { readonly t: "group"; readonly d: Doc; readonly expand: boolean }
	| { readonly t: "indent"; readonly d: Doc }
	| { readonly t: "line" | "soft" | "hard" }
	| { readonly t: "ifbreak"; readonly broken: Doc; readonly flat: Doc };

export const line: Doc = { t: "line" };
export const softline: Doc = { t: "soft" };
export const hardline: Doc = { t: "hard" };

/** Prints on one line when it fits, and breaks every `line` of it otherwise. */
export const group = (d: Doc, expand = false): Doc => ({
	t: "group",
	d,
	expand,
});
export const indent = (d: Doc): Doc => ({ t: "indent", d });
export const ifBreak = (broken: Doc, flat: Doc = ""): Doc => ({
	t: "ifbreak",
	broken,
	flat,
});

export const join = (separator: Doc, docs: readonly Doc[]): Doc =>
	docs.flatMap((doc, index) => (index === 0 ? [doc] : [separator, doc]));

const WIDTH = 80;
/** A tab counts as this many columns, as in Biome's default. */
const TAB = 2;

type Mode = "flat" | "break";
type Command = readonly [level: number, mode: Mode, doc: Doc];

function fits(rest: Command[], width: number): boolean {
	const stack = [...rest];
	let remaining = width;
	while (remaining >= 0) {
		const next = stack.pop();
		if (!next) return true;
		const [level, mode, doc] = next;
		if (typeof doc === "string") {
			remaining -= doc.length;
		} else if (Array.isArray(doc)) {
			for (let index = doc.length - 1; index >= 0; index--) {
				stack.push([level, mode, doc[index] as Doc]);
			}
		} else {
			const node = doc as Exclude<Doc, string | readonly Doc[]>;
			switch (node.t) {
				case "group":
					stack.push([level, node.expand ? "break" : mode, node.d]);
					break;
				case "indent":
					stack.push([level + 1, mode, node.d]);
					break;
				case "ifbreak":
					stack.push([level, mode, mode === "break" ? node.broken : node.flat]);
					break;
				case "line":
					if (mode === "break") return true;
					remaining -= 1;
					break;
				case "soft":
					if (mode === "break") return true;
					break;
				case "hard":
					return mode === "break";
			}
		}
	}
	return false;
}

/** Prints `doc` with tabs for indentation and a final newline. */
export function print(doc: Doc): string {
	let out = "";
	let column = 0;
	const stack: Command[] = [[0, "break", doc]];
	while (stack.length > 0) {
		const [level, mode, current] = stack.pop() as Command;
		if (typeof current === "string") {
			out += current;
			column += current.length;
		} else if (Array.isArray(current)) {
			for (let index = current.length - 1; index >= 0; index--) {
				stack.push([level, mode, current[index] as Doc]);
			}
		} else {
			const node = current as Exclude<Doc, string | readonly Doc[]>;
			switch (node.t) {
				case "group": {
					if (mode === "flat" && !node.expand) {
						stack.push([level, "flat", node.d]);
					} else {
						const flat: Command = [level, "flat", node.d];
						const fitsFlat =
							!node.expand && fits([...stack, flat], WIDTH - column);
						stack.push(fitsFlat ? flat : [level, "break", node.d]);
					}
					break;
				}
				case "indent":
					stack.push([level + 1, mode, node.d]);
					break;
				case "ifbreak":
					stack.push([level, mode, mode === "break" ? node.broken : node.flat]);
					break;
				case "line":
				case "soft":
				case "hard":
					if (mode === "flat" && node.t !== "hard") {
						if (node.t === "line") {
							out += " ";
							column += 1;
						}
					} else {
						out = `${out.replace(/[ \t]+$/, "")}\n${"\t".repeat(level)}`;
						column = level * TAB;
					}
					break;
			}
		}
	}
	return `${out}\n`;
}
