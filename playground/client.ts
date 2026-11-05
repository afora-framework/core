import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/editor.all";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import type ts from "typescript-language-service";
import { examples } from "./examples";
import type { projectInfo } from "./project";
import type { Value } from "./serialize";

const element = <T extends HTMLElement = HTMLElement>(id: string) => {
	const found = document.getElementById(id);
	if (!found) throw new Error(`Missing element ${id}`);
	return found as T;
};
const textNode = (tag: string, text: string, className = "") => {
	const node = document.createElement(tag);
	node.textContent = text;
	node.className = className;
	return node;
};
let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string) {
	element("toast").textContent = message;
	element("toast").hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		element("toast").hidden = true;
	}, 4000);
}
async function api<T>(path: string, body?: unknown): Promise<T> {
	const response = await fetch(
		path,
		body === undefined
			? undefined
			: {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-afora-playground": "1",
					},
					body: JSON.stringify(body),
				},
	);
	if (!response.ok) throw new Error(await response.text());
	return response.json();
}
type ProjectInfo = Awaited<ReturnType<typeof projectInfo>> & {
	source: boolean;
};
function showProject(info: ProjectInfo) {
	element("project-name").textContent = info.name;
	element("project-name").title = info.root;
	element("dependency-count").textContent = `(${info.dependencies.length})`;
	element("runtime-label").textContent = info.source
		? "Bun · afora de src/"
		: "Bun · dependências instaladas";
	element("dependency-note").textContent = info.source
		? "afora usa src/ neste modo de desenvolvimento."
		: "Versões instaladas · passe o mouse para ver a declaração";
	element("manifest").textContent = JSON.stringify(info.manifest, null, 2);
	element("dependencies").replaceChildren(
		...info.dependencies.map((dependency) => {
			const row = textNode(
				"div",
				"",
				`dependency ${dependency.installed ? "" : "missing"}`,
			);
			row.title = `${dependency.name}: ${dependency.requested}`;
			row.append(
				textNode("span", dependency.name),
				textNode("span", dependency.installed ?? "não instalada"),
			);
			return row;
		}),
	);
}

async function start() {
	const project = await api<ProjectInfo>("/api/project");
	showProject(project);
	const storageKey = `afora-playground:${project.root}`;
	type Saved = { id: string; name: string; code: string };
	let saved = await api<Saved[]>("/api/sandbox");
	let legacy: Saved[] = [];
	let draft: { name: string; code: string; id?: string } | undefined;
	try {
		const stored = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
		if (Array.isArray(stored.saved))
			legacy = stored.saved.filter(
				(item: Saved) =>
					typeof item.id === "string" &&
					typeof item.name === "string" &&
					typeof item.code === "string",
			);
		if (
			typeof stored.draft?.code === "string" &&
			typeof stored.draft?.name === "string"
		)
			draft = stored.draft;
	} catch {
		toast("Não foi possível recuperar os experimentos salvos.");
	}
	// Migrate browser experiments individually; retain the browser backup on failure.
	for (const item of [...legacy]) {
		try {
			const name = `${item.name}-${item.id}`;
			const migrated = saved.find((entry) => entry.name === name);
			if (migrated && migrated.code !== item.code)
				throw new Error("Migration conflict");
			if (!migrated)
				saved.push(await api<Saved>("/api/sandbox", { name, code: item.code }));
			legacy = legacy.filter((entry) => entry !== item);
		} catch {
			toast("Não foi possível migrar um experimento do navegador.");
		}
	}
	const nameInput = element<HTMLInputElement>("experiment-name");
	nameInput.value = draft?.name ?? "Primeiros passos";
	(
		globalThis as typeof globalThis & { MonacoEnvironment: monaco.Environment }
	).MonacoEnvironment = {
		getWorker: () => new Worker("/editor.worker.js", { type: "module" }),
	};
	monaco.editor.defineTheme("afora", {
		base: "vs-dark",
		inherit: true,
		rules: [
			{ token: "comment", foreground: "6E8877", fontStyle: "italic" },
			{ token: "keyword", foreground: "C3B5D9" },
			{ token: "string", foreground: "B7D99C" },
			{ token: "number", foreground: "D7BA8C" },
		],
		colors: {
			"editor.background": "#141816",
			"editor.foreground": "#D5DFD6",
			"editorLineNumber.foreground": "#4D6354",
			"editorLineNumber.activeForeground": "#ABC19E",
			"editor.selectionBackground": "#354C36",
			"editor.lineHighlightBackground": "#1B241D",
			"editorCursor.foreground": "#B3DF9E",
			"editorWidget.background": "#202A23",
			"editorSuggestWidget.background": "#202A23",
			"editorSuggestWidget.border": "#3A4C3D",
		},
	});
	element("editor").replaceChildren();
	const model = monaco.editor.createModel(
		draft?.code ?? examples[0]?.code ?? "",
		"typescript",
		monaco.Uri.file(`${project.root}/__afora_playground__.ts`),
	);
	const editor = monaco.editor.create(element("editor"), {
		model,
		theme: "afora",
		automaticLayout: true,
		fontSize: 13,
		lineHeight: 23,
		fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
		minimap: { enabled: false },
		padding: { top: 8, bottom: 20 },
		scrollBeyondLastLine: false,
		lineNumbersMinChars: 3,
		renderLineHighlight: "line",
		tabSize: 2,
		bracketPairColorization: { enabled: true },
		wordWrap: "on",
		fixedOverflowWidgets: true,
	});
	const session = crypto.randomUUID();
	const query = <T>(action: string, position = 0, extras = {}) =>
		api<T>("/api/language", {
			session,
			code: model.getValue(),
			action,
			position,
			...extras,
		});
	const display = (parts?: ts.SymbolDisplayPart[]) =>
		parts?.map((part) => part.text).join("") ?? "";
	const range = (span: ts.TextSpan) => {
		const begin = model.getPositionAt(span.start);
		const end = model.getPositionAt(span.start + span.length);
		return new monaco.Range(
			begin.lineNumber,
			begin.column,
			end.lineNumber,
			end.column,
		);
	};
	const kinds: Record<string, monaco.languages.CompletionItemKind> = {
		method: monaco.languages.CompletionItemKind.Method,
		function: monaco.languages.CompletionItemKind.Function,
		property: monaco.languages.CompletionItemKind.Property,
		class: monaco.languages.CompletionItemKind.Class,
		interface: monaco.languages.CompletionItemKind.Interface,
		const: monaco.languages.CompletionItemKind.Constant,
		keyword: monaco.languages.CompletionItemKind.Keyword,
		module: monaco.languages.CompletionItemKind.Module,
	};
	const completionMeta = new WeakMap<
		monaco.languages.CompletionItem,
		{ position: number; name: string; source?: string }
	>();
	monaco.languages.registerCompletionItemProvider("typescript", {
		triggerCharacters: [".", '"', "'", "/", "@"],
		async provideCompletionItems(_model, position, _context, token) {
			const version = model.getVersionId();
			const offset = model.getOffsetAt(position);
			const entries = await query<ts.CompletionEntry[]>("complete", offset);
			if (token.isCancellationRequested || model.getVersionId() !== version)
				return { suggestions: [] };
			const word = model.getWordUntilPosition(position);
			return {
				suggestions: entries.map((entry) => {
					const suggestion: monaco.languages.CompletionItem = {
						label: entry.name,
						kind:
							kinds[entry.kind] ?? monaco.languages.CompletionItemKind.Variable,
						insertText: entry.insertText ?? entry.name,
						sortText: entry.sortText,
						range: entry.replacementSpan
							? range(entry.replacementSpan)
							: new monaco.Range(
									position.lineNumber,
									word.startColumn,
									position.lineNumber,
									word.endColumn,
								),
					};
					completionMeta.set(suggestion, {
						position: offset,
						name: entry.name,
						source: entry.source,
					});
					return suggestion;
				}),
			};
		},
		async resolveCompletionItem(item) {
			const meta = completionMeta.get(item);
			if (!meta) return item;
			const details = await query<ts.CompletionEntryDetails | null>(
				"details",
				meta.position,
				meta,
			);
			if (details) {
				item.detail = display(details.displayParts);
				item.documentation = {
					value: display(details.documentation),
					isTrusted: false,
				};
				item.additionalTextEdits = details.codeActions?.flatMap((action) =>
					action.changes
						.filter((change) => change.fileName === model.uri.fsPath)
						.flatMap((change) =>
							change.textChanges.map((edit) => ({
								range: range(edit.span),
								text: edit.newText,
							})),
						),
				);
			}
			return item;
		},
	});
	monaco.languages.registerHoverProvider("typescript", {
		async provideHover(_model, position, token) {
			const version = model.getVersionId();
			const info = await query<ts.QuickInfo | null>(
				"hover",
				model.getOffsetAt(position),
			);
			if (
				!info ||
				token.isCancellationRequested ||
				model.getVersionId() !== version
			)
				return null;
			return {
				range: range(info.textSpan),
				contents: [
					{ value: `\`\`\`typescript\n${display(info.displayParts)}\n\`\`\`` },
					{ value: display(info.documentation), isTrusted: false },
				],
			};
		},
	});
	monaco.languages.registerSignatureHelpProvider("typescript", {
		signatureHelpTriggerCharacters: ["(", ",", "<"],
		async provideSignatureHelp(_model, position, token) {
			const info = await query<ts.SignatureHelpItems | null>(
				"signature",
				model.getOffsetAt(position),
			);
			if (!info || token.isCancellationRequested) return null;
			return {
				value: {
					activeSignature: info.selectedItemIndex,
					activeParameter: info.argumentIndex,
					signatures: info.items.map((item) => ({
						label:
							display(item.prefixDisplayParts) +
							item.parameters
								.map((parameter) => display(parameter.displayParts))
								.join(display(item.separatorDisplayParts)) +
							display(item.suffixDisplayParts),
						documentation: display(item.documentation),
						parameters: item.parameters.map((parameter) => ({
							label: display(parameter.displayParts),
							documentation: display(parameter.documentation),
						})),
					})),
				},
				dispose() {},
			};
		},
	});
	type Diagnostic = {
		start: number;
		length: number;
		message: string;
		category: number;
		code: number;
	};
	async function diagnostics() {
		const version = model.getVersionId();
		try {
			const issues = await query<Diagnostic[]>("diagnostics");
			if (model.getVersionId() !== version) return;
			monaco.editor.setModelMarkers(
				model,
				"typescript",
				issues.map((issue) => ({
					...range({ start: issue.start, length: issue.length }),
					message: issue.message,
					code: String(issue.code),
					severity:
						issue.category === 1
							? monaco.MarkerSeverity.Error
							: monaco.MarkerSeverity.Warning,
				})),
			);
			element("problem-count").textContent = String(issues.length);
			element("problems").replaceChildren(
				...issues.map((issue) => {
					const position = model.getPositionAt(issue.start);
					const button = textNode("button", issue.message, "problem");
					button.append(
						textNode(
							"small",
							`Ln ${position.lineNumber}, Col ${position.column} · TS${issue.code}`,
						),
					);
					button.onclick = () => {
						editor.setPosition(position);
						editor.revealPositionInCenter(position);
						editor.focus();
					};
					return button;
				}),
			);
			if (!issues.length)
				element("problems").append(
					textNode("p", "Nenhum problema encontrado.", "muted"),
				);
		} catch {
			element("status").textContent =
				"Serviço de tipos indisponível. Tente atualizar o projeto.";
		}
	}
	let saveWarning = false;
	function persist() {
		try {
			localStorage.setItem(
				storageKey,
				JSON.stringify({
					saved: legacy,
					draft: {
						name: nameInput.value,
						code: model.getValue(),
						id: activeSaved,
					},
				}),
			);
			element("save-state").textContent = "rascunho salvo";
		} catch {
			element("save-state").textContent = "não salvo";
			if (!saveWarning) {
				saveWarning = true;
				toast(
					"Armazenamento indisponível ou cheio. Copie seu código antes de sair.",
				);
			}
		}
	}
	let diagnosticTimer: ReturnType<typeof setTimeout>;
	model.onDidChangeContent(() => {
		persist();
		clearTimeout(diagnosticTimer);
		diagnosticTimer = setTimeout(() => void diagnostics(), 400);
	});
	nameInput.oninput = persist;
	editor.onDidChangeCursorPosition(({ position }) => {
		element("cursor").textContent =
			`Ln ${position.lineNumber}, Col ${position.column}`;
	});
	let activeSaved = saved.find((item) => item.id === draft?.id)?.id;
	function load(name: string, code: string, id?: string) {
		activeSaved = id;
		nameInput.value = name;
		model.setValue(code);
		persist();
		for (const button of element("examples").children)
			button.classList.toggle(
				"active",
				button.getAttribute("data-name") === name,
			);
		editor.focus();
	}
	element("examples").replaceChildren(
		...examples.map((example) => {
			const button = textNode(
				"button",
				"",
				`example ${example.name === nameInput.value ? "active" : ""}`,
			);
			button.setAttribute("data-name", example.name);
			button.append(
				textNode("strong", example.name),
				textNode("small", example.description),
			);
			button.onclick = () =>
				switchDocument(() => load(example.name, example.code));
			return button;
		}),
	);
	function renderSaved() {
		element("saved").replaceChildren(
			...saved.map((item) => {
				const row = textNode("div", "", "saved-item");
				const open = textNode("button", item.name);
				open.onclick = () =>
					switchDocument(() => load(item.name, item.code, item.id));
				const remove = textNode("button", "×", "icon-button");
				remove.setAttribute("aria-label", `Excluir ${item.name}`);
				remove.onclick = async () => {
					if (!confirm(`Excluir “${item.name}”?`)) return;
					try {
						await api("/api/sandbox/delete", { id: item.id });
					} catch (error) {
						toast(`Falha ao excluir: ${String(error)}`);
						return;
					}
					saved = saved.filter((entry) => entry.id !== item.id);
					if (activeSaved === item.id) activeSaved = undefined;
					persist();
					renderSaved();
				};
				row.append(open, remove);
				return row;
			}),
		);
		if (!saved.length)
			element("saved").append(
				textNode("p", "Seus experimentos aparecem aqui.", "muted"),
			);
	}
	let saving = false;
	async function saveDocument() {
		if (saving) return false;
		saving = true;
		const id = activeSaved;
		const name = nameInput.value.trim() || "Sem título";
		const code = model.getValue();
		try {
			const item = await api<Saved>("/api/sandbox", { id, name, code });
			saved = saved.filter((entry) => entry.id !== id);
			saved.push(item);
			activeSaved = item.id;
			renderSaved();
			persist();
			toast(`Salvo em .afora/sandbox/${item.id}`);
			return true;
		} catch (error) {
			toast(`Falha ao salvar: ${String(error)}`);
			return false;
		} finally {
			saving = false;
		}
	}
	// Only switch after the edited buffer has reached disk.
	async function switchDocument(next: () => void) {
		if (saving) return;
		const code = model.getValue();
		const name = nameInput.value;
		if (
			(activeSaved !== undefined ||
				(code.trim() && !examples.some((example) => example.code === code))) &&
			!saved.some(
				(item) =>
					item.id === activeSaved &&
					item.code === code &&
					item.name === nameInput.value,
			)
		) {
			if (!(await saveDocument())) return;
			if (model.getValue() !== code || nameInput.value !== name) return;
		}
		next();
	}
	element("save").onclick = () => {
		void saveDocument();
	};
	element("new").onclick = () =>
		switchDocument(() =>
			load("Novo experimento", 'import { } from "@afora/core";\n\n'),
		);
	renderSaved();
	persist();
	function selectTab(tab: "console" | "problems") {
		for (const name of ["console", "problems"]) {
			element(name).hidden = name !== tab;
			element(`${name}-tab`).classList.toggle("active", name === tab);
		}
	}
	element("console-tab").onclick = () => selectTab("console");
	element("problems-tab").onclick = () => selectTab("problems");
	let logs = 0;
	function clearConsole() {
		logs = 0;
		element("console").replaceChildren();
		element("log-count").textContent = "0";
	}
	element("clear").onclick = clearConsole;
	function tree(value: Value, depth = 0): HTMLElement {
		if (!value || typeof value !== "object")
			return textNode("div", String(value), "value");
		const details = document.createElement("details");
		details.className = "tree";
		details.open = depth < 1;
		const entries = Object.entries(value);
		details.append(
			textNode(
				"summary",
				Array.isArray(value)
					? `Array (${entries.length})`
					: `{ ${entries
							.slice(0, 4)
							.map(([key]) => key)
							.join(", ")}${entries.length > 4 ? ", …" : ""} }`,
			),
		);
		const body = textNode("div", "", "tree-body");
		for (const [key, item] of entries) {
			const row = textNode("div", "");
			row.append(
				textNode("span", `${key}: `, "tree-key"),
				tree(item, depth + 1),
			);
			body.append(row);
		}
		details.append(body);
		return details;
	}
	function log(level: string, values: Value[]) {
		if (++logs > 1000) return;
		const row = textNode("div", "", `log ${level}`);
		row.append(
			textNode("div", level, "log-label"),
			...values.map((value) => tree(value)),
		);
		element("console").append(row);
		element("log-count").textContent = String(logs);
		element("console").scrollTop = element("console").scrollHeight;
	}
	let running: AbortController | undefined;
	async function run() {
		if (running) return;
		const controller = new AbortController();
		running = controller;
		element<HTMLButtonElement>("run").disabled = true;
		element("stop").hidden = false;
		element("status").textContent = "Executando em um novo processo Bun…";
		clearConsole();
		selectTab("console");
		let completed = false;
		try {
			const response = await fetch("/api/run", {
				method: "POST",
				signal: controller.signal,
				headers: {
					"Content-Type": "application/json",
					"x-afora-playground": "1",
				},
				body: JSON.stringify({ code: model.getValue() }),
			});
			if (!response.ok) throw new Error(await response.text());
			if (!response.body) throw new Error("Sem resposta do processo.");
			let buffer = "";
			for await (const chunk of response.body.pipeThrough(
				new TextDecoderStream(),
			)) {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line) continue;
					const event = JSON.parse(line);
					if (event.type === "log" && Array.isArray(event.values))
						log(event.level, event.values);
					if (event.type === "done") {
						completed = true;
						const reason =
							event.reason === "timeout"
								? "Interrompido: limite de 10 segundos"
								: event.reason === "output-limit"
									? "Interrompido: limite de saída"
									: event.reason === "cancelled"
										? "Execução interrompida"
										: event.exitCode === 0
											? "Concluído"
											: `Terminou com erro (código ${event.exitCode})`;
						element("status").textContent = `${reason} · ${event.duration} ms`;
						if (!logs)
							element("console").append(
								textNode(
									"p",
									"Execução sem saída. Use console.log() para inspecionar valores.",
									"muted",
								),
							);
					}
				}
			}
			if (!completed)
				throw new Error("A conexão terminou antes do resultado da execução.");
		} catch (error) {
			if (controller.signal.aborted)
				element("status").textContent = "Execução interrompida";
			else {
				log("error", [String(error)]);
				element("status").textContent = "Falha na execução";
			}
		} finally {
			running = undefined;
			element<HTMLButtonElement>("run").disabled = false;
			element("stop").hidden = true;
		}
	}
	element("run").onclick = () => void run();
	element("stop").onclick = () => running?.abort();
	editor.addCommand(
		monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
		() => void run(),
	);
	editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
		element("save").click(),
	);
	element("refresh").onclick = async () => {
		try {
			showProject(await api<ProjectInfo>("/api/refresh", {}));
			saved = await api<Saved[]>("/api/sandbox");
			renderSaved();
			await diagnostics();
			toast("Projeto e tipos atualizados.");
		} catch (error) {
			toast(`Falha ao atualizar: ${String(error)}`);
		}
	};
	element<HTMLButtonElement>("run").disabled = false;
	element("status").textContent = "Pronto para experimentar";
	await diagnostics();
}
void start().catch((error) => {
	element("status").textContent = "Falha ao carregar o editor";
	element("editor").textContent = String(error);
});
