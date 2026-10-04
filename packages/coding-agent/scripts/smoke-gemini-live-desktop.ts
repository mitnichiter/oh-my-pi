#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { isEnoent, TempDir } from "@oh-my-pi/pi-utils";
import { withTimeout } from "@oh-my-pi/pi-utils/async";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { GeminiLiveDesktop } from "../src/live/desktop";
import { GeminiLiveTransport } from "../src/live/gemini-transport";
import instructions from "../src/live/prompts/gemini-instructions.md" with { type: "text" };
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

const OPERATION_TIMEOUT_MS = 30_000;
const FIXTURE_START_TIMEOUT_MS = 20_000;
const PERSIST_TIMEOUT_MS = 15_000;
const ARTIFACT_DIRECTORY = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "omp-gemini-live-desktop-artifacts");
const CAPTURE_ARTIFACT = path.join(ARTIFACT_DIRECTORY, "capture.png");
const TYPED_ARTIFACT = path.join(ARTIFACT_DIRECTORY, "typed.png");
const FAILURE_ARTIFACT = path.join(ARTIFACT_DIRECTORY, "failure.png");

interface WireReply {
	setup?: unknown;
	realtimeInput?: { video?: { data: string; mimeType: string } };
	toolResponse?: {
		functionResponses: Array<{ id: string; response: { result?: string; error?: string } }>;
	};
}

interface PendingReply {
	resolve: (value: { result?: string; error?: string }) => void;
	reject: (error: Error) => void;
}

function normalizeEditorText(text: string): string {
	return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeout: number, message: string): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!(await check())) {
		if (Date.now() >= deadline) throw new Error(message);
		await Bun.sleep(50);
	}
}

if (process.platform !== "win32") {
	throw new Error("Gemini Live desktop smoke requires an interactive Windows desktop");
}

await fs.rm(ARTIFACT_DIRECTORY, { recursive: true, force: true });

const tempDir = await TempDir.create("omp-gemini-live-desktop-");
const title = `OMP Gemini Live desktop smoke ${crypto.randomUUID()}`;
const outputFile = tempDir.join("editor-output.txt");
const readyFile = tempDir.join("fixture-ready.txt");
const persistedOutput = Bun.file(outputFile);
const fixtureScript = path.join(import.meta.dir, "fixtures", "gemini-live-desktop-editor.ps1");
const marker = "OMP Gemini Live — café 漢字 😀\nsecond line: λ 🚀";
const replies = new Map<string, PendingReply>();
const videos: Array<{ data: string; mimeType: string }> = [];
const accepted = Promise.withResolvers<Bun.ServerWebSocket<undefined>>();

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request, bunServer) {
		if (bunServer.upgrade(request)) return;
		return new Response("WebSocket required", { status: 400 });
	},
	websocket: {
		open(socket) {
			accepted.resolve(socket);
		},
		message(socket, data) {
			const packet = JSON.parse(String(data)) as WireReply;
			if (packet.setup) socket.send(JSON.stringify({ setupComplete: {} }));
			if (packet.realtimeInput?.video) videos.push(packet.realtimeInput.video);
			for (const response of packet.toolResponse?.functionResponses ?? []) {
				replies.get(response.id)?.resolve(response.response);
			}
		},
	},
});

const auth = await AuthStorage.create(tempDir.join("auth.db"));
auth.keys.setRuntime("google", "loopback-desktop-smoke-only");
const mock = createMockModel();
const session = new AgentSession({
	agent: new Agent({ initialState: { model: mock, tools: [], systemPrompt: [] }, streamFn: mock.stream }),
	sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
	settings: Settings.isolated({
		"computer.enabled": true,
		"live.computer": true,
		"tools.approval.computer": "allow",
		"compaction.enabled": false,
	}),
	modelRegistry: new ModelRegistry(auth, tempDir.join("models.yml")),
});
const desktop = new GeminiLiveDesktop(session);
const transport = new GeminiLiveTransport({
	authStorage: auth,
	sessionId: session.sessionId,
	model: "gemini-3.8-live-extended-thinking",
	voice: "Aoede",
	thinkingLevel: "high",
	instructions,
	desktop,
	createSocket: () => new WebSocket(`ws://127.0.0.1:${server.port}`),
	callbacks: {
		onEvent(event) {
			if (event.type !== "error") return;
			for (const pending of replies.values()) pending.reject(new Error(event.message));
		},
		onOutputLevel: () => undefined,
	},
});

const fixture = Bun.spawn(
	[
		"powershell.exe",
		"-NoLogo",
		"-NoProfile",
		"-STA",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		fixtureScript,
		"-WindowTitle",
		title,
		"-OutputPath",
		outputFile,
		"-ReadyPath",
		readyFile,
	],
	{ stdout: "pipe", stderr: "pipe", windowsHide: false },
);
const fixtureStdout = new Response(fixture.stdout).text();
const fixtureStderr = new Response(fixture.stderr).text();

async function executeDesktop(
	code: string,
	readOnly = false,
): Promise<{
	text: string;
	images: Array<{ data: string; mimeType: string }>;
}> {
	const id = crypto.randomUUID();
	const pending = Promise.withResolvers<{ result?: string; error?: string }>();
	replies.set(id, pending);
	const firstVideo = videos.length;
	const socket = await withTimeout(accepted.promise, OPERATION_TIMEOUT_MS, "Loopback websocket was not accepted");
	socket.send(
		JSON.stringify({
			toolCall: { functionCalls: [{ id, name: "desktop", args: { code, read_only: readOnly } }] },
		}),
	);
	try {
		const response = await withTimeout(pending.promise, OPERATION_TIMEOUT_MS, "Live desktop response timed out");
		if (response.error) throw new Error(response.error);
		return { text: response.result ?? "", images: videos.slice(firstVideo) };
	} finally {
		replies.delete(id);
	}
}

let failure: unknown;
try {
	await waitUntil(
		async () => {
			if (fixture.exitCode !== null) {
				throw new Error(`GUI fixture exited before becoming ready (exit ${fixture.exitCode})`);
			}
			try {
				await fs.access(readyFile);
				return true;
			} catch (error) {
				if (isEnoent(error)) return false;
				throw error;
			}
		},
		FIXTURE_START_TIMEOUT_MS,
		"Windows GUI fixture did not become ready",
	);

	await withTimeout(transport.connect(), OPERATION_TIMEOUT_MS, "Gemini Live loopback setup timed out");
	const selector = JSON.stringify(title);
	const capture = await executeDesktop(
		`const target = ${selector};
await wait(() => desktop.windows({title: target}).then(windows => windows.length === 1), {timeout: 15000, interval: 100});
const fixture = await desktop.window({title: target});
const shot = await fixture.screenshot();
const capabilities = await desktop.capabilities();
if (!capabilities.capture || !capabilities.input || !capabilities.ax || !capabilities.takeover) {
  throw new Error("Windows desktop capabilities are incomplete: " + JSON.stringify(capabilities));
}
return {title: fixture.title, width: shot.width, height: shot.height, capabilities};`,
		true,
	);
	if (capture.images.length !== 1) {
		throw new Error(`Expected one realtimeInput.video packet, received ${capture.images.length}`);
	}
	const captureVideo = capture.images[0]!;
	if (captureVideo.mimeType !== "image/png") {
		throw new Error(`Expected image/png realtime video, received ${captureVideo.mimeType}`);
	}
	const png = Buffer.from(captureVideo.data, "base64");
	if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || png.length < 24) {
		throw new Error("Gemini Live realtime video payload is not a valid PNG");
	}
	const width = png.readUInt32BE(16);
	const height = png.readUInt32BE(20);
	if (width < 100 || height < 100) throw new Error(`Captured fixture PNG is unexpectedly small: ${width}x${height}`);
	await Bun.write(CAPTURE_ARTIFACT, png);

	await executeDesktop(`const target = ${selector};
const fixture = await desktop.window({title: target});
const shot = await fixture.screenshot({silent: true});
const editors = await fixture.find({role: "textfield", title: "Gemini Live owned editor", limit: 2});
if (editors.length !== 1) throw new Error("Expected exactly one owned text editor, found " + editors.length);
const bounds = await editors[0].bounds();
if (!bounds || bounds.width <= 0 || bounds.height <= 0) throw new Error("Owned text editor has no usable bounds");
const x = ((bounds.x + bounds.width / 2) - fixture.bounds.x) * shot.width / fixture.bounds.width;
const y = ((bounds.y + bounds.height / 2) - fixture.bounds.y) * shot.height / fixture.bounds.height;
if (!(x >= 0 && x < shot.width && y >= 0 && y < shot.height)) {
  throw new Error("Editor center falls outside the captured coordinate frame");
}
await fixture.click(x, y, {takeover: true});
await fixture.type(${JSON.stringify(marker)}, {takeover: true});
return {coordinateFrame: {width: shot.width, height: shot.height}, click: {x, y}, editorBounds: bounds};`);

	await waitUntil(
		async () => {
			if (fixture.exitCode !== null) throw new Error(`GUI fixture exited during input (exit ${fixture.exitCode})`);
			try {
				return normalizeEditorText(await persistedOutput.text()) === marker;
			} catch (error) {
				if (isEnoent(error)) return false;
				throw error;
			}
		},
		PERSIST_TIMEOUT_MS,
		"GUI fixture did not persist the complete Unicode/newline input",
	);
	const persisted = normalizeEditorText(await persistedOutput.text());
	if (persisted !== marker) {
		throw new Error(`Persisted editor text mismatch: ${JSON.stringify(persisted)}`);
	}

	const typedCapture = await executeDesktop(
		`const fixture = await desktop.window({title: ${selector}});
await fixture.screenshot();
return {title: fixture.title};`,
		true,
	);
	const typedVideo = typedCapture.images.at(-1);
	if (typedVideo?.mimeType !== "image/png") throw new Error("Typed editor screenshot was not delivered over Live");
	await Bun.write(TYPED_ARTIFACT, Buffer.from(typedVideo.data, "base64"));

	await withTimeout(transport.close(), OPERATION_TIMEOUT_MS, "Desktop worker teardown timed out");
	let rejection: unknown;
	try {
		await withTimeout(
			desktop.execute("await desktop.screenshot()", undefined, true),
			OPERATION_TIMEOUT_MS,
			"Closed desktop worker stalled on further work",
		);
	} catch (error) {
		rejection = error;
	}
	if (!(rejection instanceof Error) || !/closed/i.test(rejection.message)) {
		throw new Error(
			rejection
				? `Closed Gemini Live desktop worker returned an unexpected error: ${String(rejection)}`
				: "Closed Gemini Live desktop worker accepted further actions",
		);
	}

	console.log(
		JSON.stringify({
			path: "loopback websocket -> GeminiLiveTransport -> approved desktop prelude -> native Windows GUI",
			capture: { mimeType: captureVideo.mimeType, width, height, artifact: CAPTURE_ARTIFACT },
			persistedText: persisted,
			typedArtifact: TYPED_ARTIFACT,
			teardown: "transport close disposed the worker and rejected further actions",
		}),
	);
} catch (error) {
	failure = error;
	const latestVideo = videos.at(-1);
	if (latestVideo?.mimeType === "image/png") {
		try {
			await Bun.write(FAILURE_ARTIFACT, Buffer.from(latestVideo.data, "base64"));
			console.error(`Failure screenshot: ${FAILURE_ARTIFACT}`);
		} catch (error) {
			console.error("Could not save the desktop failure screenshot", error);
		}
	}
} finally {
	for (const pending of replies.values()) pending.reject(new Error("Desktop smoke is shutting down"));
	replies.clear();
	try {
		await withTimeout(transport.close(), OPERATION_TIMEOUT_MS, "Desktop worker cleanup timed out");
	} catch (error) {
		failure ??= error;
	}
	try {
		await withTimeout(session.dispose(), OPERATION_TIMEOUT_MS, "Agent session cleanup timed out");
	} catch (error) {
		failure ??= error;
	}
	try {
		auth.close();
	} catch (error) {
		failure ??= error;
	}
	server.stop(true);
	try {
		if (fixture.exitCode === null) fixture.kill();
	} catch (error) {
		failure ??= error;
	}
	let fixtureExited = fixture.exitCode !== null;
	try {
		await withTimeout(fixture.exited, 10_000, "GUI fixture process did not exit during cleanup");
		fixtureExited = true;
	} catch (error) {
		failure ??= error;
		fixture.unref();
	}
	if (fixtureExited) {
		const [stdout, stderr] = await Promise.all([fixtureStdout, fixtureStderr]);
		if (failure && (stdout.trim() || stderr.trim())) {
			console.error([stdout.trim(), stderr.trim()].filter(Boolean).join("\n"));
		}
	}
	try {
		await withTimeout(tempDir.remove(), 10_000, "Temporary desktop smoke storage cleanup timed out");
	} catch (error) {
		failure ??= error;
	}
}

if (failure) throw failure;
