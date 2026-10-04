import * as assert from "node:assert/strict";
import { type } from "@oh-my-pi/omptype";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { LiveSessionController, type LiveTranscript } from "@oh-my-pi/pi-coding-agent/live/controller";
import { GeminiLiveTransport } from "@oh-my-pi/pi-coding-agent/live/gemini-transport";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const timeout = setTimeout(() => {
	console.error("voice-smoke: deadline exceeded");
	process.exit(1);
}, 20_000);
const temp = TempDir.createSync("@omp-voice-smoke-");
const auth = await AuthStorage.create(":memory:");
auth.keys.setRuntime("google", "owned-loopback-key");
const oldStarted = Promise.withResolvers<void>();
const completed = Promise.withResolvers<unknown>();
const audio = Promise.withResolvers<string>();
const endedInput = Promise.withResolvers<void>();
const accepted = Promise.withResolvers<Bun.ServerWebSocket<undefined>>();
const transcript = Promise.withResolvers<LiveTranscript>();
const setupShape = type({ setup: { tools: type({ functionDeclarations: type({ name: "string", behavior: "string" }).array() }).array() } });
const replyShape = type({ toolResponse: { functionResponses: type({ id: "string", name: "string", response: { result: "string" } }).array() } });
const inputShape = type({ realtimeInput: { "audio?": { data: "string", mimeType: "string" }, "audioStreamEnd?": "boolean" } });
let receivedSetup = false;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request, host) {
		if (host.upgrade(request)) return;
		return new Response("WebSocket required", { status: 400 });
	},
	websocket: {
		open(peer) {
			accepted.resolve(peer);
		},
		message(peer, data) {
			const decoded: unknown = JSON.parse(String(data));
			if (!receivedSetup) {
				const setup = setupShape.assert(decoded);
				assert.deepEqual(setup.setup.tools.flatMap(tool => tool.functionDeclarations.map(fn => [fn.name, fn.behavior])), [["delegate", "NON_BLOCKING"]]);
				receivedSetup = true;
				peer.send(Buffer.from(JSON.stringify({ setupComplete: {} })));
				return;
			}
			const response = replyShape(decoded);
			if (!(response instanceof type.errors)) {
				completed.resolve(response);
				return;
			}
			const input = inputShape(decoded);
			if (input instanceof type.errors) return;
			if (input.realtimeInput.audio) audio.resolve(input.realtimeInput.audio.data);
			if (input.realtimeInput.audioStreamEnd) endedInput.resolve();
		},
	},
});
const mock = createMockModel({
	provider: "openai",
	id: "gpt-owned-voice-smoke",
	responses: [
		() => {
			oldStarted.resolve();
			return { content: ["cancelled old result"], delayMs: 60_000 };
		},
		{ content: ["replacement result: café 漢字 😀"] },
	],
});
const agent = new Agent({
	getApiKey: () => "owned-mock-key",
	initialState: { model: mock.model, systemPrompt: [], tools: [], messages: [] },
	streamFn: mock.stream,
	convertToLlm,
});
const settings = Settings.isolated({ "live.provider": "google", "compaction.enabled": false, "todo.enabled": false });
settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
const session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(temp.path()), settings, modelRegistry: new ModelRegistry(auth) });
let capture: ((error: Error | null, samples: Float32Array) => void) | undefined;
let captureStopped = false;
const controller = new LiveSessionController({
	session,
	callbacks: {
		onPhase: () => undefined,
		onLevels: () => undefined,
		onTranscript: update => { if (update?.final && update.role === "user") transcript.resolve(update); },
		onTerminal: error => { if (error) completed.reject(error); },
	},
	extractAssistantText: message => message.content.map(part => part.type === "text" ? part.text : "").join(""),
}, {
	createTransport: (callbacks, instructions) => new GeminiLiveTransport({
		authStorage: auth,
		sessionId: "owned-voice-smoke",
		model: "gemini-3.8-live-extended-thinking",
		voice: "Aoede",
		thinkingLevel: "high",
		instructions,
		callbacks,
		createSocket: () => new WebSocket(`ws://127.0.0.1:${server.port}`),
		createPlayback: () => ({ write: () => undefined, stop: () => undefined }),
	}),
	createRecorder: (_rate, onAudio) => {
		capture = onAudio;
		return { stop: () => { captureStopped = true; } };
	},
});
try {
	await controller.start();
	assert.equal(controller.provider, "google");
	assert.equal(session.model?.id, mock.model.id);
	const peer = await accepted.promise;
	peer.send(Buffer.from(JSON.stringify({ serverContent: { inputTranscription: { text: "Please inspect café 漢字 😀", finished: true }, turnComplete: true } })));
	assert.equal((await transcript.promise).text, "Please inspect café 漢字 😀");
	assert.ok(capture);
	capture(null, new Float32Array([-1, 0, 1]));
	assert.equal(await audio.promise, "AIAAAP9/");
	controller.toggleMute();
	await endedInput.promise;
	assert.equal(controller.muted, true);
	controller.toggleMute();
	peer.send(Buffer.from(JSON.stringify({ toolCall: { functionCalls: [{ id: "old", name: "delegate", args: { request: "Inspect old task" } }] } })));
	await oldStarted.promise;
	peer.send(Buffer.from(JSON.stringify({ toolCallCancellation: { ids: ["old"] }, toolCall: { functionCalls: [{ id: "replacement", name: "delegate", args: { request: "Inspect replacement task" } }] } })));
	const response = replyShape.assert(await completed.promise).toolResponse.functionResponses;
	assert.deepEqual(response, [{ id: "replacement", name: "delegate", response: { result: "replacement result: café 漢字 😀" } }]);
	assert.equal(mock.calls.length, 2);
	await controller.stop();
	assert.equal(captureStopped, true);
	console.log("voice-smoke: binary websocket → controller → real AgentSession cancellation/replacement → matching Unicode function result; PCM/mute/cleanup passed");
} finally {
	await controller.stop();
	await session.dispose();
	server.stop(true);
	auth.close();
	temp.removeSync();
	clearTimeout(timeout);
}
