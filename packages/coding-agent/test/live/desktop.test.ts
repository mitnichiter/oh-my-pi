import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { GeminiLiveDesktop } from "../../src/live/desktop";
import { cfgLiveComputer } from "../../src/live/settings";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { cfgComputerEnabled } from "../../src/tools/settings";

async function withDesktop(
	settings: Settings,
	run: (desktop: GeminiLiveDesktop, code: string, destination: string) => Promise<void>,
): Promise<void> {
	using dir = TempDir.createSync("@omp-live-desktop-permission-");
	const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	await auth.credentials.reload();
	const model = createMockModel();
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, tools: [], systemPrompt: [] }, streamFn: model.stream }),
		sessionManager: SessionManager.create(dir.path(), dir.join("sessions")),
		settings,
		modelRegistry: new ModelRegistry(auth, dir.join("models.yml")),
	});
	const desktop = new GeminiLiveDesktop(session);
	const destination = dir.join("unauthorized.txt");
	const code = `await Bun.write(${JSON.stringify(destination)}, "unauthorized mutation");`;
	try {
		await run(desktop, code, destination);
	} finally {
		await desktop.close();
		await session.dispose();
		auth.close();
	}
}

function enabledSettings(): Settings {
	return Settings.isolated({
		"computer.enabled": true,
		"live.computer": true,
		"tools.approval.computer": "allow",
		"compaction.enabled": false,
	});
}

describe("Gemini Live desktop permissions", () => {
	for (const [name, definition] of [
		["computer.enabled", cfgComputerEnabled],
		["live.computer", cfgLiveComputer],
	] as const) {
		test(`revoking ${name} blocks an existing Live bridge before host code runs`, async () => {
			const settings = enabledSettings();
			await withDesktop(settings, async (desktop, code, destination) => {
				definition.override(settings, false);
				await expect(desktop.execute(code)).rejects.toThrow(/not enabled/);
				expect(await Bun.file(destination).exists()).toBe(false);
			});
		});
	}

	test("approval-required desktop calls fail closed without executing host code", async () => {
		const settings = Settings.isolated({
			"computer.enabled": true,
			"live.computer": true,
			"tools.approval.computer": "prompt",
			"compaction.enabled": false,
		});
		await withDesktop(settings, async (desktop, code, destination) => {
			await expect(desktop.execute(code)).rejects.toThrow(/requires approval/);
			expect(await Bun.file(destination).exists()).toBe(false);
		});
	});
});
