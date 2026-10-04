import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { AgentSession } from "../session/agent-session";
import type { ToolSession } from "../tools";
import { createComputerPrelude } from "../tools/computer";
import { cfgLiveComputer } from "./settings";
import { type EvalPreludeDefinition, invokeEvalPrelude } from "../eval/preludes";

export interface GeminiLiveDesktopResult {
	text: string;
	images: Array<{ data: string; mimeType: string }>;
}

interface ComputerRunDetails {
	value?: unknown;
}

/** Adapts the live controller's AgentSession to the computer prelude and its permission-aware tool bridge. */
function createToolSession(
	session: AgentSession,
	getEvalPreludes: () => readonly EvalPreludeDefinition[],
): ToolSession {
	return {
		get cwd() {
			return session.sessionManager.getCwd();
		},
		hasUI: false,
		settings: session.settings,
		getSessionSpawns: () => null,
		getSessionFile: () => session.sessionFile ?? null,
		getEvalSessionId: () => session.getEvalSessionId(),
		getEvalKernelOwnerId: () => session.getEvalKernelOwnerId(),
		getSessionId: () => session.sessionId,
		getToolByName: name => session.getToolByName(name),
		getToolForEvalBridge: name => session.getToolForEvalBridge(name),
		getEvalBridgeToolNames: () => session.getEvalBridgeToolNames(),
		getEvalPreludes,
		getActiveModel: () => session.model ?? undefined,
	};
}

function stringifyReturnValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

/** Executes Gemini Live desktop JavaScript through the standard, session-scoped computer prelude. */
export class GeminiLiveDesktop {
	readonly #toolSession: ToolSession;
	readonly #prelude: EvalPreludeDefinition;
	#closed = false;

	constructor(session: AgentSession) {
		this.#toolSession = createToolSession(session, () => {
			const current = session.getEvalPreludes().filter(candidate => candidate.name !== "computer");
			return [this.#prelude, ...current];
		});
		const computerPrelude = createComputerPrelude(this.#toolSession);
		const computerEnabled = computerPrelude.enabled;
		this.#prelude = {
			...computerPrelude,
			enabled: () => cfgLiveComputer.get(session.settings) === true && computerEnabled?.() !== false,
		};
	}

	async execute(code: string, signal?: AbortSignal, readOnly = false): Promise<GeminiLiveDesktopResult> {
		if (this.#closed) throw new ToolError("Gemini Live desktop session is closed");
		const result = await invokeEvalPrelude(
			"computer",
			{ action: "run", code, read_only: readOnly },
			{
				session: this.#toolSession,
				toolCallId: `gemini-live-desktop-${crypto.randomUUID()}`,
				signal,
			},
		);
		return this.#result(result);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#prelude.invoke(
			{ action: "close" },
			{
				session: this.#toolSession,
				toolCallId: `gemini-live-desktop-close-${crypto.randomUUID()}`,
			},
		);
	}

	#result(result: AgentToolResult<unknown>): GeminiLiveDesktopResult {
		const textParts = result.content
			.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map(content => content.text);
		const details = result.details as ComputerRunDetails | undefined;
		if (details?.value !== undefined) textParts.push(stringifyReturnValue(details.value));
		const images = result.content
			.filter((content): content is { type: "image"; data: string; mimeType: string } => content.type === "image")
			.map(({ data, mimeType }) => ({ data, mimeType }));
		return { text: textParts.join("\n"), images };
	}
}
