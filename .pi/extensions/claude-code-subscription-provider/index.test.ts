import assert from "node:assert/strict";
import test from "node:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeContext, getSupportedThinkingLevels, type Model, type Api, type SimpleStreamOptions, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession, generateSummaryWithUsage, generateBranchSummary, type ProviderConfig, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerProvider, { CLAUDE_CODE_MODELS, CLAUDE_CODE_PROVIDER, captureFreshTokenBundle, fetchUsageLimits, formatUsageLimit, isAuthenticationError, loginClaudeCode, normalizeClaudeCodeUserAgent, rewriteClaudeCodePayload, runJsonCommand, streamClaudeCodeProvider } from "./index.ts";

const token = { accessToken: "sk-ant-oat-AUDIT-FIXTURE-NOT-A-REAL-TOKEN", capturedAt: Date.now(), expiresAt: Date.now() + 3600000 };
const loadToken = async () => token;
type Wire = { body: Record<string, any>; headers: Headers };

function model(id = "opus-5-5"): Model<Api> {
	return { ...CLAUDE_CODE_MODELS.find((m) => m.id === id)!, type: "chat", api: "claude-code-anthropic", provider: CLAUDE_CODE_PROVIDER, reasoning: true, input: ["text", "image"], baseUrl: "http://127.0.0.1:9" };
}

function response(modelId: string, stopReason = "end_turn", tool = false): Response {
	const blocks: any[] = tool
		? [{ type: "thinking", thinking: "Check the file", signature: "fixture-signature" }, { type: "tool_use", id: "tool_fixture", name: "Read", input: { path: "src/example.ts" } }]
		: [{ type: "text", text: "## Goal\nKeep the provider working.\n## Next Steps\nContinue testing. Žluťoučký." }];
	const events: any[] = [{ type: "message_start", message: { id: "fixture-response", type: "message", role: "assistant", model: modelId, content: [], usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 2 } } }];
	blocks.forEach((block, index) => {
		events.push({ type: "content_block_start", index, content_block: block.type === "tool_use" ? { ...block, input: {} } : block });
		if (block.type === "tool_use") events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
		events.push({ type: "content_block_stop", index });
	});
	events.push({ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : stopReason }, usage: { output_tokens: 10 } }, { type: "message_stop" });
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

function fixtureFetch(wire: Wire[], reply = (body: any) => response(body.model)): NonNullable<SimpleStreamOptions["fetch"]> {
	return async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		wire.push({ body, headers: new Headers(init?.headers) });
		return reply(body);
	};
}

const context = () => normalizeContext({ systemPrompt: "Follow the user's instructions.", messages: [{ role: "user", content: "Hello", timestamp: 0 }] });

async function call(options: SimpleStreamOptions = {}, selected = model(), input = context()) {
	const wire: Wire[] = [];
	const stream = streamClaudeCodeProvider(selected, input, { fetch: fixtureFetch(wire), ...options }, loadToken);
	const events = [];
	for await (const event of stream) events.push(event);
	return { wire, events, result: await stream.result() };
}

test("recognizes rotated OAuth tokens but not unrelated permission errors", () => {
	assert.equal(isAuthenticationError('403 permission_error: OAuth authentication is currently not allowed for this organization. oauth_not_allowed_for_organization'), true);
	assert.equal(isAuthenticationError("401 authentication_error: invalid bearer token"), true);
	assert.equal(isAuthenticationError("403 permission_error: model access denied"), false);
	assert.equal(isAuthenticationError("429 rate_limit_error"), false);
});

test("upgrades stale user agents without downgrading newer Claude Code", () => {
	assert.equal(normalizeClaudeCodeUserAgent("claude-cli/2.1.251 (external, sdk-cli)"), "claude-cli/2.1.290 (external, sdk-cli)");
	assert.equal(normalizeClaudeCodeUserAgent("claude-cli/2.1.280 (external, sdk-cli)"), "claude-cli/2.1.290 (external, sdk-cli)");
	assert.equal(normalizeClaudeCodeUserAgent("claude-cli/2.1.299 (external, sdk-cli)"), "claude-cli/2.1.299 (external, sdk-cli)");
});

test("inherits current pricing, thinking capabilities and cache lifetimes from Pi", () => {
	const native = new Map(getBuiltinModels("anthropic").map((m) => [m.id, m]));
	for (const def of CLAUDE_CODE_MODELS) {
		const expected = native.get(def.anthropicId) ?? native.get("claude-fable-5-1")!;
		const expectedCost = def.id === "fable-5-2" ? { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 } : expected.cost;
		assert.deepEqual(def.cost, expectedCost);
		assert.deepEqual(def.thinkingLevelMap, expected.thinkingLevelMap);
		assert.deepEqual(def.promptCache, { short: 300, long: 3600 });
		assert.equal(def.compat?.forceAdaptiveThinking, true);
	}
	assert.equal(model("sonnet-4-6").contextWindow, 256000);
	assert.deepEqual(getSupportedThinkingLevels(model()), ["low", "medium", "high", "xhigh", "max"]);
});

test("does not inflate small output caps or send disabled thinking to always-on models", async () => {
	for (const id of ["opus-5-5", "opus-5", "fable-5-2", "fable-5-1", "fable-5"]) {
		const { wire, result } = await call({ maxTokens: 1024, cacheRetention: "none" }, model(id));
		assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
		assert.equal(wire[0].body.max_tokens, 1024);
		assert.equal(wire[0].body.thinking.type, "adaptive");
		assert.equal(JSON.stringify(wire[0].body).includes("cache_control"), false);
	}
});

test("Fable 5.2 maps to the upstream model with adaptive thinking, 1M context and all effort levels", async () => {
	const selected = model("fable-5-2");
	assert.equal(selected.contextWindow, 1_000_000);
	assert.equal(selected.maxTokens, 128_000);
	assert.deepEqual(getSupportedThinkingLevels(selected), getSupportedThinkingLevels(model("fable-5-1")));
	assert.equal((selected as Model<"anthropic-messages">).compat?.allowedFallbackModels, undefined);
	for (const reasoning of ["low", "medium", "high", "xhigh", "max"] as const) {
		const { wire, result } = await call({ reasoning }, selected);
		assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
		assert.equal(result.model, "fable-5-2");
		assert.equal(wire[0].body.model, "claude-fable-5-2");
		assert.equal(wire[0].headers.get("user-agent"), "claude-cli/2.1.290 (external, sdk-cli)");
		assert.match(JSON.stringify(wire[0].body.system), /cc_version=2\.1\.290\./);
		assert.equal(wire[0].body.thinking.type, "adaptive");
		assert.equal(wire[0].body.thinking.display, "summarized");
		assert.equal(wire[0].body.messages.at(-1).output_config.effort, reasoning);
		assert.match(wire[0].headers.get("anthropic-beta")!, /context-1m-2025-08-07/);
		assert.match(wire[0].headers.get("anthropic-beta")!, /thinking-binding-controls-2026-08-01/);
	}
});

test("maps max effort and keeps unsupported effort choices out of model selection", async () => {
	for (const id of ["opus-5-5", "opus-4-6", "sonnet-4-6"]) {
		const { wire } = await call({ reasoning: "max" }, model(id));
		assert.match(JSON.stringify(wire[0].body), /"effort":"max"/);
	}
});

test("preserves string system prompts and caller-owned context management", () => {
	const payload = { system: "Summarize this conversation, don't continue it.", messages: [{ role: "user", content: "history" }], max_tokens: 4096, context_management: { edits: [] } };
	const rewritten = rewriteClaudeCodePayload(payload, "session") as any;
	assert.match(JSON.stringify(rewritten.messages), /Summarize this conversation/);
	assert.equal(rewritten.max_tokens, 4096);
	assert.deepEqual(rewritten.context_management, { edits: [] });
	assert.equal(payload.system, "Summarize this conversation, don't continue it.");
});

test("stable session routing and billing prefix, unique request IDs, correct Sonnet betas", async () => {
	const first = await call({ sessionId: "stable-session" });
	const second = await call({ sessionId: "stable-session" });
	assert.deepEqual(first.wire[0].body.system, second.wire[0].body.system);
	assert.equal(first.wire[0].headers.get("x-claude-code-session-id"), "stable-session");
	assert.notEqual(first.wire[0].headers.get("x-client-request-id"), second.wire[0].headers.get("x-client-request-id"));
	assert.match(first.wire[0].headers.get("anthropic-beta")!, /thinking-binding-controls-2026-08-01/);
	const sonnet = await call({}, model("sonnet-4-6"));
	assert.doesNotMatch(sonnet.wire[0].headers.get("anthropic-beta")!, /context-1m/);
});

test("instrumentation sees the actual rewritten request and Pi-facing model identity", async () => {
	let observed: any;
	let responseModel: Model<Api> | undefined;
	let rawEvents = 0;
	const { wire, result, events } = await call({
		onPayload: (payload, selected) => { observed = payload; assert.equal(selected.id, "opus-5-5"); return { ...payload as object, metadata: { user_id: "fixture" } }; },
		onResponse: (_response, selected) => { responseModel = selected; },
		onProviderStreamEvent: (_event, selected) => { assert.equal(selected.id, "opus-5-5"); rawEvents++; },
	});
	assert.match(JSON.stringify(observed.system), /billing-header/);
	assert.equal(wire[0].body.metadata.user_id, "fixture");
	assert.equal(responseModel!.id, "opus-5-5");
	assert.ok(rawEvents > 0);
	assert.equal(result.model, "opus-5-5");
	assert.equal(result.api, "claude-code-anthropic");
	assert.equal(result.usage.totalTokens, 32);
	assert.equal(events.filter((e) => e.type === "start").length, 1);
	assert.equal(events.filter((e) => e.type === "done" || e.type === "error").length, 1);
});

for (const id of ["opus-5-5", "fable-5-2"]) test(`${id}: tool calls and signed thinking survive replay without mutating history`, async () => {
	const wire: Wire[] = [];
	const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }];
	const firstContext = normalizeContext({ tools, messages: [{ role: "user", content: "Read it", timestamp: 0 }] });
	const first = await streamClaudeCodeProvider(model(id), firstContext, { fetch: fixtureFetch(wire, (body) => response(body.model, "tool_use", true)), sessionId: "tool-loop" }, loadToken).result();
	assert.equal(first.stopReason, "toolUse");
	const toolCall = first.content.find((c) => c.type === "toolCall")!;
	assert.equal(toolCall.name, "read");
	assert.deepEqual(toolCall.arguments, { path: "src/example.ts" });
	const next = normalizeContext({ tools, messages: [...firstContext.messages.filter((m) => m.role !== "system"), first, { role: "toolResult", toolCallId: toolCall.id, toolName: "read", content: [{ type: "text", text: "file content" }], isError: false, timestamp: 1 }] });
	const result = await streamClaudeCodeProvider(model(id), next, { fetch: fixtureFetch(wire), sessionId: "tool-loop" }, loadToken).result();
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
	assert.match(JSON.stringify(wire[1].body.messages), /fixture-signature/);
	assert.equal(first.api, "claude-code-anthropic");
	assert.equal(first.model, id);
	const switched = await streamClaudeCodeProvider(model("sonnet-4-6"), next, { fetch: fixtureFetch(wire) }, loadToken).result();
	assert.equal(switched.stopReason, "stop");
	assert.doesNotMatch(JSON.stringify(wire.at(-1)!.body.messages), /fixture-signature/);
});

test("long cache retention requests the native one-hour lifetime", async () => {
	const { wire } = await call({ cacheRetention: "long" });
	assert.match(JSON.stringify(wire[0].body), /"ttl":"1h"/);
});

test("permission errors do not trigger an auth refresh", async () => {
	const wire: Wire[] = [];
	let loads = 0;
	const stream = streamClaudeCodeProvider(model(), context(), { fetch: fixtureFetch(wire, () => new Response(JSON.stringify({ error: { type: "permission_error", message: "Model access denied" } }), { status: 403, headers: { "content-type": "application/json" } })) }, async () => { loads++; return token; });
	assert.equal((await stream.result()).stopReason, "error");
	assert.equal(loads, 1);
	assert.equal(wire.length, 1);
});

test("does not refresh or duplicate a response after visible streaming has started", async () => {
	const wire: Wire[] = [];
	let loads = 0;
	const stream = streamClaudeCodeProvider(model(), context(), { fetch: fixtureFetch(wire, (body) => {
		const text = [
			{ type: "message_start", message: { id: "partial", type: "message", role: "assistant", model: body.model, content: [], usage: { input_tokens: 20, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "Partial" } },
			{ type: "error", error: { type: "authentication_error", message: "Invalid bearer token" } },
		].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
		return new Response(text, { headers: { "content-type": "text/event-stream" } });
	}) }, async () => { loads++; return token; });
	const events = [];
	for await (const event of stream) events.push(event.type);
	assert.equal((await stream.result()).stopReason, "error");
	assert.equal(loads, 1);
	assert.equal(events.filter((e) => e === "start").length, 1);
	assert.equal(events.filter((e) => e === "error").length, 1);
});

test("refreshes invalid tokens once before publishing any events", async () => {
	const wire: Wire[] = [];
	const refreshes: boolean[] = [];
	const stream = streamClaudeCodeProvider(model(), context(), { fetch: fixtureFetch(wire, (body) => wire.length === 1 ? new Response(JSON.stringify({ error: { type: "authentication_error", message: "Invalid bearer token" } }), { status: 401, headers: { "content-type": "application/json" } }) : response(body.model)) }, async (refresh) => { refreshes.push(!!refresh); return token; });
	const events = [];
	for await (const event of stream) events.push(event.type);
	assert.equal((await stream.result()).stopReason, "stop");
	assert.deepEqual(refreshes, [false, true]);
	assert.equal(events.filter((e) => e === "start").length, 1);
	assert.equal(events.filter((e) => e === "done").length, 1);
});

test("a token rejected after refresh tells the user how to log in from Pi", async () => {
	const unauthorized = () => new Response(JSON.stringify({ error: { type: "authentication_error", message: "Invalid bearer token" } }), { status: 401, headers: { "content-type": "application/json" } });
	const result = await streamClaudeCodeProvider(model(), context(), { fetch: fixtureFetch([], unauthorized) }, loadToken).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /Invalid bearer token.*\/claude-code-auth login/);
});

async function withFakeClaude(script: string, run: (env: NodeJS.ProcessEnv) => Promise<void>) {
	const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "claude-login-test-"));
	try {
		await fsp.writeFile(path.join(directory, "claude"), `#!${process.execPath}\n${script}`, { mode: 0o700 });
		await run({ ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, TMPDIR: directory });
	} finally { await fsp.rm(directory, { recursive: true, force: true }); }
}

test("logged-out and expired Claude Code logins point to /claude-code-auth login", async () => {
	// Real `claude auth status` prints valid JSON but exits 1 when logged out.
	await withFakeClaude(`console.log(JSON.stringify({ loggedIn: false, authMethod: 'none' })); process.exit(1);`, async (env) => {
		await assert.rejects(captureFreshTokenBundle(undefined, env), /not logged in.*\/claude-code-auth login/);
	});
	// A dead refresh token still reports loggedIn; the probe exits before any request.
	await withFakeClaude(`
		if (process.argv.includes('status')) console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
		else { console.error('Failed to authenticate: OAuth session expired and could not be refreshed'); process.exit(1); }
	`, async (env) => {
		await assert.rejects(captureFreshTokenBundle(undefined, env), /probably expired.*\/claude-code-auth login/);
	});
});

test("login drives claude auth login through the browser callback or a pasted code", async () => {
	const url = "https://claude.com/cai/oauth/authorize?code=true&state=fixture";
	const fakeLogin = `
		process.stdout.write('Opening browser to sign in…\\nIf the browser didn\\'t open, visit: \\x1b]8;;${url}\\x07${url}\\x1b]8;;\\x07\\nPaste code here if prompted > ');
		if (process.env.FAKE_LOGIN === 'callback') setTimeout(() => process.exit(0), 100);
		process.stdin.once('data', (line) => {
			if (String(line).trim() === 'good#state') process.exit(0);
			console.log('Login failed: Request failed with status code 400'); process.exit(1);
		});
	`;
	const ui = (answer?: string) => {
		const seen = { notified: "", dismissed: false };
		return { seen, ui: {
			notify: (message: string) => { seen.notified += message; },
			input: (_title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) => answer === "wait"
				? new Promise<string | undefined>((resolve) => opts!.signal!.addEventListener("abort", () => { seen.dismissed = true; resolve(undefined); }))
				: Promise.resolve(answer),
		} };
	};
	await withFakeClaude(fakeLogin, async (env) => {
		const pasted = ui("good#state");
		await loginClaudeCode(pasted.ui, env);
		assert.equal(pasted.seen.notified.split("\n").at(-1), url);

		const callback = ui("wait");
		await loginClaudeCode(callback.ui, { ...env, FAKE_LOGIN: "callback" });
		assert.equal(callback.seen.dismissed, true);

		await assert.rejects(loginClaudeCode(ui("bad#state").ui, env), /^Error: Login failed: Request failed with status code 400$/);
		await assert.rejects(loginClaudeCode(ui(undefined).ui, env), /exited/);
	});
});

test("a pre-aborted request does not load credentials or spawn an auth probe", async () => {
	const controller = new AbortController();
	controller.abort();
	let loads = 0;
	const result = await streamClaudeCodeProvider(model(), context(), { signal: controller.signal }, async () => { loads++; return token; }).result();
	assert.equal(result.stopReason, "aborted");
	assert.equal(loads, 0);
});

test("subprocess cancellation, timeouts and invalid JSON do not leak stdout", async () => {
	const controller = new AbortController();
	const command = runJsonCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], controller.signal);
	controller.abort();
	await assert.rejects(command, /abort/i);
	await assert.rejects(runJsonCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], undefined, 50), /timed out/);
	await assert.rejects(runJsonCommand(process.execPath, ["-e", "console.log('sk-ant-oat-SECRET')"]), (error: any) => !error.message.includes("SECRET") && error.message.includes("invalid JSON"));
});

test("setup-token capture shares refreshes, survives one cancelled waiter, detects token changes and writes a private cache", async () => {
	const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "claude-auth-test-"));
	try {
		await fsp.writeFile(path.join(directory, "claude"), `#!${process.execPath}\n
			const fs = require('node:fs');
			if (process.argv.includes('status')) {
				console.log(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }));
			} else {
				fs.appendFileSync(${JSON.stringify(path.join(directory, "probes"))}, 'probe\\n');
				const proxy = new URL(process.env.HTTPS_PROXY);
				const req = require('node:http').request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: 'api.anthropic.com:443' });
				req.on('connect', (_response, socket) => {
					const secure = require('node:tls').connect({ socket, servername: 'api.anthropic.com', ca: fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS) }, () => secure.write('POST /v1/messages HTTP/1.1\\r\\nHost: api.anthropic.com\\r\\nAuthorization: Bearer ' + process.env.CLAUDE_CODE_OAUTH_TOKEN + '\\r\\nContent-Length: 2\\r\\n\\r\\n{}'));
					secure.on('error', () => {}); secure.resume();
				}); req.end();
			}
		`, { mode: 0o700 });
		const providerUrl = new URL("./index.ts", import.meta.url).href;
		const code = `
			import { getTokenBundle } from ${JSON.stringify(providerUrl)};
			import fs from 'node:fs/promises';
			const controller = new AbortController();
			const first = getTokenBundle(true, controller.signal).then(() => 'unexpected', () => 'aborted');
			const second = getTokenBundle(true);
			setTimeout(() => controller.abort(), 50);
			const [cancelled, captured] = await Promise.all([first, second]);
			const reused = await getTokenBundle();
			const changed = await getTokenBundle(false, undefined, { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-CHANGED-FIXTURE' });
			const mode = (await fs.stat(process.env.PI_CODING_AGENT_DIR + '/cache/claude-code-subscription-provider.json')).mode & 0o777;
			console.log(JSON.stringify({ cancelled, reused: reused.accessToken === captured.accessToken, changed: changed.accessToken === 'sk-ant-oat-CHANGED-FIXTURE', mode }));
		`;
		const result = await runJsonCommand<any>(process.execPath, ["--import", fileURLToPath(import.meta.resolve("tsx")), "--input-type=module", "-e", code], undefined, 15000, { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, TMPDIR: directory, PI_CODING_AGENT_DIR: directory, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-INITIAL-FIXTURE" });
		assert.deepEqual(result, { cancelled: "aborted", reused: true, changed: true, mode: 0o600 });
		assert.equal((await fsp.readFile(path.join(directory, "probes"), "utf8")).trim().split("\n").length, 2);
	} finally { await fsp.rm(directory, { recursive: true, force: true }); }
});

test("native compaction and branch summarizers preserve instructions, caps and no-cache requests", async () => {
	const wire: Wire[] = [];
	const streamFn = (selected: Model<Api>, input: any, options?: SimpleStreamOptions) => streamClaudeCodeProvider(selected, input, { ...options, fetch: fixtureFetch(wire) }, loadToken);
	const messages = [{ role: "user" as const, content: "Fix src/example.ts", timestamp: 0 }];
	const summary = await generateSummaryWithUsage(messages, model(), 16384, undefined, undefined, undefined, "Preserve file paths", undefined, "off", streamFn);
	assert.match(summary.text, /Keep the provider working/);
	assert.equal(wire[0].body.max_tokens, Math.floor(0.8 * 16384));
	assert.match(JSON.stringify(wire[0].body.messages), /Preserve file paths/);
	const updated = await generateSummaryWithUsage(messages, model(), 16384, undefined, undefined, undefined, undefined, summary.text, undefined, streamFn);
	assert.ok(updated.usage.totalTokens > 0);
	assert.match(JSON.stringify(wire[1].body.messages), /previous-summary/);
	const branch = await generateBranchSummary([{ type: "message", id: "entry", parentId: null, timestamp: new Date().toISOString(), message: messages[0] }], { model: model(), streamFn, signal: new AbortController().signal });
	assert.match(branch.summary!, /Keep the provider working/);
	assert.equal(wire[2].body.max_tokens, 4096);
	for (const request of wire) {
		assert.equal(request.body.thinking.type, "adaptive");
		assert.doesNotMatch(JSON.stringify(request.body), /cache_control/);
		assert.match(JSON.stringify(request.body.messages), /summar/i);
	}
});

test("native summarizers reject truncated responses instead of saving partial summaries", async () => {
	const wire: Wire[] = [];
	const streamFn = (selected: Model<Api>, input: any, options?: SimpleStreamOptions) => streamClaudeCodeProvider(selected, input, { ...options, fetch: fixtureFetch(wire, (body) => response(body.model, "max_tokens")) }, loadToken);
	const message = { role: "user" as const, content: "history", timestamp: 0 };
	await assert.rejects(generateSummaryWithUsage([message], model(), 16384, undefined, undefined, undefined, undefined, undefined, undefined, streamFn), /incomplete/);
	const branch = await generateBranchSummary([{ type: "message", id: "entry", parentId: null, timestamp: new Date().toISOString(), message }], { model: model(), streamFn, signal: new AbortController().signal });
	assert.match(branch.error!, /incomplete/);
});

for (const id of ["opus-5-5", "fable-5-2"]) test(`${id}: AgentSession.compact and navigateTree persist native summaries through the registered provider`, async () => {
	const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "claude-provider-session-test-"));
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const wire: Wire[] = [];
		let config!: ProviderConfig;
		registerProvider({ registerProvider: (_name: string, value: ProviderConfig) => { config = value; }, registerCommand: () => {}, on: () => {} } as unknown as ExtensionAPI);
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
		runtime.registerProvider(CLAUDE_CODE_PROVIDER, { ...config, streamSimple: (selected, input, options) => streamClaudeCodeProvider(selected, input, { ...options, fetch: fixtureFetch(wire) }, loadToken) });
		await runtime.refresh({ allowNetwork: false });
		const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 32 } });
		const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
		await loader.reload();
		const manager = SessionManager.inMemory(directory);
		manager.appendModelChange(CLAUDE_CODE_PROVIDER, id);
		const oldEntry = manager.appendMessage({ role: "user", content: "Old work on src/example.ts. ".repeat(100), timestamp: 0 });
		const assistant = (text: string): AssistantMessage => ({ role: "assistant", api: "claude-code-anthropic", provider: CLAUDE_CODE_PROVIDER, model: id, content: [{ type: "text", text }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 });
		manager.appendMessage(assistant("Implemented the change."));
		manager.appendMessage({ role: "user", content: "Continue testing", timestamp: 2 });
		manager.appendMessage(assistant("Tests are ready. ".repeat(20)));
		({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, model: runtime.getModel(CLAUDE_CODE_PROVIDER, id)!, sessionManager: manager, settingsManager: settings, resourceLoader: loader, noTools: "all" }));
		const compacted = await session.compact("Preserve src/example.ts");
		assert.match(compacted.summary, /Keep the provider working/);
		assert.ok(manager.getEntries().some((entry) => entry.type === "compaction"));
		const navigation = await session.navigateTree(oldEntry, { summarize: true, customInstructions: "Keep completed work" });
		assert.equal(navigation.cancelled, false);
		assert.ok(manager.getEntries().some((entry) => entry.type === "branch_summary"));
		assert.equal(wire.at(-1)!.body.max_tokens, 4096);
	} finally {
		session?.dispose();
		await fsp.rm(directory, { recursive: true, force: true });
	}
});

test("footer shows usage only for this provider, skips malformed headers and clears when switching away", () => {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	registerProvider({ registerProvider: () => {}, registerCommand: () => {}, on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler) } as unknown as ExtensionAPI);
	const statuses: Array<string | undefined> = [];
	const ctx = (provider: string) => ({ model: { provider }, ui: { setStatus: (_key: string, text?: string) => statuses.push(text) } });
	const respond = (provider: string, headers: Record<string, string>) => handlers.get("after_provider_response")!({ status: 200, headers }, ctx(provider));
	const headers = { "anthropic-ratelimit-unified-5h-utilization": "0.22", "anthropic-ratelimit-unified-7d-utilization": "0.29" };
	respond("anthropic", headers);
	respond(CLAUDE_CODE_PROVIDER, headers);
	respond(CLAUDE_CODE_PROVIDER, { ...headers, "anthropic-ratelimit-unified-5h-utilization": "n/a" });
	respond(CLAUDE_CODE_PROVIDER, { "anthropic-ratelimit-unified-status": "allowed" });
	handlers.get("model_select")!({ model: { provider: CLAUDE_CODE_PROVIDER } }, ctx(CLAUDE_CODE_PROVIDER));
	handlers.get("model_select")!({ model: { provider: "anthropic" } }, ctx("anthropic"));
	assert.deepEqual(statuses, ["Claude 5h 22% · 7d 29%", "Claude 7d 29%", undefined]);
});

function usageResponse(limits: unknown[]): Response {
	return new Response(JSON.stringify({ limits }), { headers: { "content-type": "application/json" } });
}

function rateLimited(): Response {
	return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limited" } }), { status: 429, headers: { "content-type": "application/json" } });
}

test("usage limits label per-model limits and skip entries whose shape changed", async () => {
	const now = Date.UTC(2026, 10, 12, 12);
	const usage = await fetchUsageLimits(token, undefined, async (url, init) => {
		assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
		assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token.accessToken}`);
		return usageResponse([
			{ kind: "session", percent: 22, resets_at: "2026-11-12T15:30:00Z", scope: null },
			null,
			{ kind: "weekly_all", percent: 29, resets_at: "2026-11-16T18:00:00Z" },
			{ kind: "weekly_all", resets_at: "2026-11-16T18:00:00Z" },
			{ kind: "weekly_scoped", percent: 10, resets_at: "2026-11-16T18:00:00Z", scope: { model: { id: null, display_name: "Fable" } } },
			{ kind: "weekly_oauth_apps", percent: 0, resets_at: null },
		]);
	});
	assert.deepEqual(usage.map((limit) => formatUsageLimit(limit, now)), [
		"Session (5h): 22% used, resets in 3h 30m",
		"Weekly: 29% used, resets in 4d 6h",
		"Weekly Fable: 10% used, resets in 4d 6h",
		"weekly_oauth_apps: 0% used",
	]);
});

test("usage lookups retry with a fresh token on 401 but not on other failures", async () => {
	const refreshed = { ...token, accessToken: "sk-ant-oat-REFRESHED-FIXTURE" };
	const lookUpAfter = (status: number) => {
		const sentTokens: string[] = [];
		const usage = fetchUsageLimits(token, undefined, async (_url, init) => {
			sentTokens.push(new Headers(init?.headers).get("authorization")!);
			return sentTokens.length === 1 ? new Response("{}", { status }) : usageResponse([{ kind: "session", percent: 1, resets_at: null }]);
		}, async () => refreshed);
		return { sentTokens, usage };
	};
	const unauthorized = lookUpAfter(401);
	assert.equal((await unauthorized.usage).length, 1);
	assert.deepEqual(unauthorized.sentTokens, [`Bearer ${token.accessToken}`, `Bearer ${refreshed.accessToken}`]);
	const forbidden = lookUpAfter(403);
	await assert.rejects(forbidden.usage, /failed \(403\)/);
	assert.deepEqual(forbidden.sentTokens, [`Bearer ${token.accessToken}`]);
});

test("a 429 names the exhausted subscription limit with the request's own token", async () => {
	const resetsAt = new Date(Date.now() + 90 * 60_000).toISOString();
	const wire: Wire[] = [];
	let loads = 0;
	const stream = streamClaudeCodeProvider(model(), context(), {
		fetch: async (url, init) => {
			if (String(url).endsWith("/api/oauth/usage")) {
				assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token.accessToken}`);
				return usageResponse([
					{ kind: "session", percent: 100, resets_at: resetsAt, scope: null },
					{ kind: "weekly_all", percent: 40, resets_at: resetsAt, scope: null },
				]);
			}
			return fixtureFetch(wire, rateLimited)(url, init);
		},
	}, async () => { loads++; return token; });
	const result = await stream.result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /Rate limited/);
	assert.match(result.errorMessage!, /Session \(5h\): 100% used, resets in 1h 30m\.$/);
	assert.doesNotMatch(result.errorMessage!, /Weekly/);
	assert.equal(wire.length, 1);
	assert.equal(loads, 1);
});

test("a failed or malformed usage lookup keeps the original 429 and never refreshes the token", async () => {
	for (const usage of [() => new Response("{}", { status: 401 }), () => new Response("not json", { status: 200 }), () => usageResponse([{ percent: 100 }])]) {
		let loads = 0;
		const stream = streamClaudeCodeProvider(model(), context(), {
			fetch: async (url) => String(url).endsWith("/api/oauth/usage") ? usage() : rateLimited(),
		}, async () => { loads++; return token; });
		const result = await stream.result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage!, /Rate limited/);
		assert.doesNotMatch(result.errorMessage!, /used|Cannot read|usage/);
		assert.equal(loads, 1);
	}
});

test("cancelling during the 429 usage lookup ends the request as aborted", async () => {
	const controller = new AbortController();
	const stream = streamClaudeCodeProvider(model(), context(), {
		signal: controller.signal,
		fetch: async (url, init) => {
			if (!String(url).endsWith("/api/oauth/usage")) return rateLimited();
			controller.abort();
			assert.equal(init!.signal!.aborted, true);
			throw init!.signal!.reason;
		},
	}, loadToken);
	assert.equal((await stream.result()).stopReason, "aborted");
});
