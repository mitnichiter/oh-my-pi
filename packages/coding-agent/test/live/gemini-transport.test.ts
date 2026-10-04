import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { type } from "@oh-my-pi/omptype";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { GeminiLiveTransport } from "../../src/live/gemini-transport";
import type { LiveServerEvent } from "../../src/live/protocol";

class Inbox<T> {
	#values: T[] = [];
	#readers: Array<(value: T) => void> = [];
	push(value: T): void {
		const reader = this.#readers.shift();
		if (reader) reader(value);
		else this.#values.push(value);
	}
	next(): Promise<T> {
		if (this.#values.length) return Promise.resolve(this.#values.shift()!);
		const pending = Promise.withResolvers<T>();
		this.#readers.push(pending.resolve);
		return pending.promise;
	}
}

async function harness() {
	const incoming = new Inbox<unknown>();
	const events = new Inbox<LiveServerEvent>();
	const played = new Inbox<Float32Array>();
	const stopped = new Inbox<void>();
	const accepted = Promise.withResolvers<Bun.ServerWebSocket<undefined>>();
	let setupReceived = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response("WebSocket required", { status: 400 });
		},
		websocket: {
			open(socket) {
				accepted.resolve(socket);
			},
			message(socket, data) {
				incoming.push(JSON.parse(String(data)) as unknown);
				if (!setupReceived) {
					setupReceived = true;
					socket.send(JSON.stringify({ setupComplete: {} }));
				}
			},
		},
	});
	const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	await auth.credentials.reload();
	auth.keys.setRuntime("google", "local-test-key");
	const transport = new GeminiLiveTransport({
		authStorage: auth,
		sessionId: "local-live-session",
		model: "gemini-3.8-live-extended-thinking",
		voice: "Aoede",
		thinkingLevel: "high",
		instructions: "Local protocol test",
		createSocket: () => new WebSocket(`ws://127.0.0.1:${server.port}`),
		createPlayback: () => ({ write: samples => played.push(samples), stop: () => stopped.push() }),
		callbacks: { onEvent: event => events.push(event), onOutputLevel: () => {} },
	});
	try {
		await transport.connect();
		const peer = await accepted.promise;
		await incoming.next(); // Setup is exercised, not asserted as a static echo.
		await events.next(); // Connected notification.
		return {
			transport,
			peer,
			incoming,
			events,
			played,
			stopped,
			async close() {
				await transport.close();
				server.stop(true);
				auth.close();
			},
		};
	} catch (cause) {
		await transport.close();
		server.stop(true);
		auth.close();
		throw cause;
	}
}

const audioInput = type({ realtimeInput: { audio: { data: "string", mimeType: "string" } } });

describe("Gemini Live websocket", () => {
	test("microphone PCM is clipped/encoded; mute ends input; barge-in drops queued playback", async () => {
		const h = await harness();
		try {
			h.transport.pushAudio(new Float32Array([-2, -0.5, 0, 0.5, 2]));
			const packet = audioInput.assert(await h.incoming.next());
			const bytes = Buffer.from(packet.realtimeInput.audio.data, "base64");
			expect(Array.from({ length: 5 }, (_, index) => bytes.readInt16LE(index * 2))).toEqual([
				-32768, -16384, 0, 16383, 32767,
			]);
			expect(packet.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
			await h.transport.setMuted(true);
			expect(await h.incoming.next()).toEqual({ realtimeInput: { audioStreamEnd: true } });
			h.transport.pushAudio(new Float32Array([1]));
			await h.transport.setMuted(false);
			h.transport.pushAudio(new Float32Array([0.25]));
			const resumed = audioInput.assert(await h.incoming.next());
			expect(Buffer.from(resumed.realtimeInput.audio.data, "base64").readInt16LE()).toBe(8191);
			h.peer.send(
				JSON.stringify({
					serverContent: {
						modelTurn: {
							parts: [
								{
									inlineData: {
										data: Buffer.from([0, 128, 0, 0, 255, 127]).toString("base64"),
										mimeType: "audio/pcm;rate=24000",
									},
								},
							],
						},
					},
				}),
			);
			expect(Array.from(await h.played.next())).toEqual([-1, 0, 32767 / 32768]);
			h.peer.send(JSON.stringify({ serverContent: { interrupted: true } }));
			await h.stopped.next();
			// A following chunk opens a new playback stream rather than playing the interrupted queue.
			h.peer.send(
				JSON.stringify({
					serverContent: {
						modelTurn: {
							parts: [
								{
									inlineData: {
										data: "AEA=",
										mimeType: "audio/pcm;rate=24000",
									},
								},
							],
						},
					},
				}),
			);
			expect(Array.from(await h.played.next())).toEqual([0.5]);
		} finally {
			await h.close();
		}
	});

	test("async delegation remains usable after turnComplete and completes with its matching function ID", async () => {
		const h = await harness();
		try {
			h.peer.send(JSON.stringify({ serverContent: { turnComplete: true, interactionStatus: "IN_PROGRESS" } }));
			expect(await h.events.next()).toEqual({ type: "interaction.status", working: true });
			h.peer.send(
				JSON.stringify({
					toolCall: {
						functionCalls: [{ id: "work-1", name: "delegate", args: { request: "Inspect the build" } }],
					},
				}),
			);
			expect(await h.events.next()).toMatchObject({ type: "delegation.created", item: { id: "work-1" } });
			await h.transport.completeDelegation("work-1", "The build fails because its entry is missing.");
			expect(await h.incoming.next()).toEqual({
				toolResponse: {
					functionResponses: [
						{
							id: "work-1",
							name: "delegate",
							response: { result: "The build fails because its entry is missing." },
						},
					],
				},
			});
			h.peer.send(JSON.stringify({ serverContent: { interactionStatus: "IDLE" } }));
			expect(await h.events.next()).toEqual({ type: "interaction.status", working: false });
		} finally {
			await h.close();
		}
	});

	test("cancelled delegation cannot answer a later call; invalid desktop args never execute", async () => {
		const h = await harness();
		try {
			h.peer.send(
				JSON.stringify({
					toolCall: { functionCalls: [{ id: "old", name: "delegate", args: { request: "Old task" } }] },
				}),
			);
			await h.events.next();
			h.peer.send(JSON.stringify({ toolCallCancellation: { ids: ["old"] } }));
			expect(await h.events.next()).toEqual({ type: "delegation.cancelled", id: "old" });
			h.peer.send(
				JSON.stringify({
					toolCall: { functionCalls: [{ id: "new", name: "delegate", args: { request: "New task" } }] },
				}),
			);
			await h.events.next();
			await h.transport.completeDelegation("old", "Stale result");
			await h.transport.completeDelegation("new", "Current result");
			expect(await h.incoming.next()).toEqual({
				toolResponse: {
					functionResponses: [
						{
							id: "new",
							name: "delegate",
							response: { result: "Current result" },
						},
					],
				},
			});
			h.peer.send(
				JSON.stringify({
					toolCall: {
						functionCalls: [{ id: "bad", name: "desktop", args: { code: "return 1", read_only: "false" } }],
					},
				}),
			);
			expect(await h.incoming.next()).toMatchObject({
				toolResponse: { functionResponses: [{ id: "bad", response: { error: "Invalid tool arguments" } }] },
			});
		} finally {
			await h.close();
		}
	});
});
