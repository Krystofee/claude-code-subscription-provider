import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
	createAssistantMessageEventStream,
	streamSimpleAnthropic,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);
const { Proxy } = require("http-mitm-proxy");

type ClaudeAuthStatus = {
	loggedIn?: boolean;
	authMethod?: string;
	apiProvider?: string;
	email?: string;
	orgId?: string;
	orgName?: string;
	subscriptionType?: string;
};

type ClaudeCodeTokenBundle = {
	accessToken: string;
	capturedAt: number;
	expiresAt: number;
	anthropicBeta?: string;
	userAgent?: string;
	xApp?: string;
};

const CLAUDE_CODE_PROVIDER = "claude-code-subscription-provider";

// The set of models this provider exposes. Each entry maps a pi-facing id (what
// shows up in `/model`) to the real Anthropic model id we send upstream. The
// cost / contextWindow / maxTokens / thinkingLevelMap values mirror pi-ai 0.77's
// native `anthropic` catalog so the subscription path behaves like first-party.
//
// thinkingLevelMap: pi's ThinkingLevel tops out at "xhigh". Opus 4.6's adaptive
// thinking calls its top effort "max" (xhigh -> "max"); Opus 4.7/4.8 renamed that
// cap to "xhigh" (xhigh -> "xhigh"); Sonnet 4.6 uses pi's default mapping. All
// four use the adaptive thinking format (forced via compat.forceAdaptiveThinking
// in toAnthropicModel).
type ClaudeCodeModelDef = {
	id: string;
	anthropicId: string;
	name: string;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
};

const OPUS_COST = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const SONNET_COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

const CLAUDE_CODE_MODELS: ClaudeCodeModelDef[] = [
	{
		id: "opus-4-8",
		anthropicId: "claude-opus-4-8",
		name: "Claude Code Subscription Provider / Opus 4.8 (1M)",
		cost: OPUS_COST,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		thinkingLevelMap: { xhigh: "xhigh" },
	},
	{
		id: "opus-4-7",
		anthropicId: "claude-opus-4-7",
		name: "Claude Code Subscription Provider / Opus 4.7 (1M)",
		cost: OPUS_COST,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		thinkingLevelMap: { xhigh: "xhigh" },
	},
	{
		id: "opus-4-6",
		anthropicId: "claude-opus-4-6",
		name: "Claude Code Subscription Provider / Opus 4.6 (1M)",
		cost: OPUS_COST,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		thinkingLevelMap: { xhigh: "max" },
	},
	{
		id: "sonnet-4-6",
		anthropicId: "claude-sonnet-4-6",
		name: "Claude Code Subscription Provider / Sonnet 4.6 (256k)",
		cost: SONNET_COST,
		// Subscription tier caps Sonnet at 256k context (1M requires usage credits).
		contextWindow: 256_000,
		maxTokens: 64_000,
	},
];

const ANTHROPIC_ID_BY_MODEL_ID = new Map(
	CLAUDE_CODE_MODELS.map((model): [string, string] => [model.id, model.anthropicId]),
);

// Model used for the auth-capture probe and status text. The probe only needs a
// valid model so `claude` emits a request we can sniff the bearer token from —
// any subscription model works, so we pin it to the default.
const DEFAULT_MODEL_ID = "opus-4-8";
const CAPTURE_ANTHROPIC_MODEL = ANTHROPIC_ID_BY_MODEL_ID.get(DEFAULT_MODEL_ID) ?? "claude-opus-4-8";
const CAPTURE_PROMPT = "Reply with exactly OK.";
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
const CAPTURE_TIMEOUT_MS = 90 * 1000;
const CACHE_FILE = path.join(os.homedir(), ".pi", "agent", "cache", "claude-code-subscription-provider.json");
const DEFAULT_USER_AGENT = "claude-cli/2.1.100 (external, sdk-cli)";
const DEFAULT_X_APP = "cli";
const DEFAULT_MAX_TOKENS = 64_000;
const REQUIRED_BETAS = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"context-1m-2025-08-07",
	"interleaved-thinking-2025-05-14",
	"context-management-2025-06-27",
	"prompt-caching-scope-2026-01-05",
	"advisor-tool-2026-03-01",
	"advanced-tool-use-2025-11-20",
	"effort-2025-11-24",
];
// Opting into the 1M beta routes the request to the long-context tier. That tier
// is included for Opus on a Max subscription but NOT for Sonnet — sending this
// beta on Sonnet gets a 429 "Usage credits are required for long context
// requests" even on tiny prompts. So only send it for models that advertise 1M.
const CONTEXT_1M_BETA = "context-1m-2025-08-07";
const MODEL_IDS_WITH_1M = new Set(
	CLAUDE_CODE_MODELS.filter((model) => model.contextWindow >= 1_000_000).map((model) => model.id),
);
const CLAUDE_CODE_SDK_SYSTEM_TEXT = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_CODE_CONTEXT_MANAGEMENT = {
	edits: [{ type: "clear_thinking_20251015", keep: "all" }],
};

let inflightTokenRefresh: Promise<ClaudeCodeTokenBundle> | null = null;

function splitBetas(value?: string): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

function normalizeAnthropicBeta(_value?: string): string {
	return REQUIRED_BETAS.join(",");
}

function betaHeaderForModel(modelId: string): string {
	const betas = MODEL_IDS_WITH_1M.has(modelId)
		? REQUIRED_BETAS
		: REQUIRED_BETAS.filter((beta) => beta !== CONTEXT_1M_BETA);
	return betas.join(",");
}

function buildBillingHeader(): string {
	const cch = Math.floor(10000 + Math.random() * 90000);
	return `x-anthropic-billing-header: cc_version=2.1.100.714; cc_entrypoint=sdk-cli; cch=${cch};`;
}

function wrapSystemReminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`;
}

function toContentArray(content: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(content)) {
		return content.map((item) => ({ ...(item as Record<string, unknown>) }));
	}
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	return [];
}

function extractSystemReminderBlocks(system: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(system)) return [];
	return system.flatMap((block) => {
		if (!block || typeof block !== "object") return [];
		const typedBlock = block as Record<string, unknown>;
		if (typedBlock.type !== "text") return [];
		const text = typeof typedBlock.text === "string" ? typedBlock.text.trim() : "";
		if (!text) return [];
		return [{ type: "text", text: wrapSystemReminder(text) }];
	});
}

function injectSystemRemindersIntoMessages(
	messages: unknown,
	reminderBlocks: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	const normalizedMessages = Array.isArray(messages)
		? messages.map((message) => ({ ...(message as Record<string, unknown>) }))
		: [];
	if (reminderBlocks.length === 0) return normalizedMessages;
	const userMessageIndex = normalizedMessages.findIndex((message) => message.role === "user");
	if (userMessageIndex === -1) {
		return [{ role: "user", content: reminderBlocks }, ...normalizedMessages];
	}
	const userMessage = normalizedMessages[userMessageIndex];
	const content = toContentArray(userMessage.content);
	normalizedMessages[userMessageIndex] = {
		...userMessage,
		content: [...reminderBlocks, ...content],
	};
	return normalizedMessages;
}

function normalizeOpus4xThinking(payload: Record<string, unknown>) {
	const model = typeof payload.model === "string" ? payload.model : "";
	const isOpus4xHidden =
		model.includes("opus-4-7") ||
		model.includes("opus-4.7") ||
		model.includes("opus-4-8") ||
		model.includes("opus-4.8");
	if (!isOpus4xHidden) return;

	// Opus 4.7+ defaults thinking.display to "omitted", which makes thinking_delta
	// events empty (only signature_delta is sent). Explicitly opt in to summarized
	// thinking so users see reasoning in the UI, matching Opus 4.6 behavior.
	// https://platform.claude.com/docs/en/about-claude/models/migration-guide#migrating-to-claude-opus-4-7
	const thinking = payload.thinking;
	if (thinking && typeof thinking === "object" && (thinking as Record<string, unknown>).type === "adaptive") {
		const thinkingObj = { ...(thinking as Record<string, unknown>) };
		if (thinkingObj.display == null) {
			thinkingObj.display = "summarized";
		}
		payload.thinking = thinkingObj;
	}
}

function rewriteClaudeCodePayload(payload: unknown): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const next = structuredClone(payload as Record<string, unknown>);
	const reminderBlocks = extractSystemReminderBlocks(next.system);
	next.system = [
		{ type: "text", text: buildBillingHeader() },
		{ type: "text", text: CLAUDE_CODE_SDK_SYSTEM_TEXT },
	];
	next.messages = injectSystemRemindersIntoMessages(next.messages, reminderBlocks);
	if (typeof next.max_tokens !== "number" || next.max_tokens < DEFAULT_MAX_TOKENS) {
		next.max_tokens = DEFAULT_MAX_TOKENS;
	}
	if (next.context_management == null) {
		next.context_management = CLAUDE_CODE_CONTEXT_MANAGEMENT;
	}
	normalizeOpus4xThinking(next);
	return next;
}

function getHeader(headers: Record<string, unknown> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const target = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== target) continue;
		if (Array.isArray(value)) return value.join(", ");
		return value == null ? undefined : String(value);
	}
	return undefined;
}

function isCacheFresh(bundle: ClaudeCodeTokenBundle | null | undefined): bundle is ClaudeCodeTokenBundle {
	return !!bundle && bundle.expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now();
}

async function ensureDir(filePath: string) {
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function readTokenCache(): Promise<ClaudeCodeTokenBundle | null> {
	try {
		const raw = await fsp.readFile(CACHE_FILE, "utf8");
		const parsed = JSON.parse(raw) as ClaudeCodeTokenBundle;
		if (!parsed?.accessToken) return null;
		return parsed;
	} catch {
		return null;
	}
}

async function writeTokenCache(bundle: ClaudeCodeTokenBundle): Promise<void> {
	await ensureDir(CACHE_FILE);
	await fsp.writeFile(CACHE_FILE, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
}

async function clearTokenCache(): Promise<void> {
	try {
		await fsp.unlink(CACHE_FILE);
	} catch {}
}

function buildLoginHint(status?: ClaudeAuthStatus): string {
	const statusSummary = status?.loggedIn
		? `Claude Code authMethod=${status.authMethod ?? "unknown"}, subscription=${status.subscriptionType ?? "unknown"}`
		: "Claude Code is not logged in.";
	return [
		statusSummary,
		`Run \`claude auth login --claudeai\` in another terminal, finish the Claude subscription login, then retry.`,
	].join(" ");
}

async function runClaudeAuthStatus(): Promise<ClaudeAuthStatus> {
	return await new Promise((resolve, reject) => {
		const child = spawn("claude", ["auth", "status"], {
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code !== 0) {
				reject(new Error(`claude auth status failed (${code ?? "unknown"}): ${stderr || stdout}`));
				return;
			}
			try {
				resolve(JSON.parse(stdout));
			} catch (error) {
				reject(new Error(`Failed to parse claude auth status output: ${stdout || stderr}`));
			}
		});
	});
}

async function ensureClaudeSubscriptionAuth(interactive = false): Promise<ClaudeAuthStatus> {
	const status = await runClaudeAuthStatus();
	const okay = status.loggedIn && status.authMethod === "claude.ai";
	if (okay) return status;
	if (interactive) {
		throw new Error(buildLoginHint(status));
	}
	throw new Error(buildLoginHint(status));
}

function createProviderError(model: Model<Api>, message: string, aborted = false): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}

function isAuthenticationError(errorMessage?: string): boolean {
	const value = (errorMessage || "").toLowerCase();
	return (
		value.includes("401") ||
		value.includes("authentication_error") ||
		value.includes("invalid bearer token") ||
		value.includes("unauthorized") ||
		value.includes("invalid x-api-key") ||
		value.includes("access token")
	);
}

async function getFreePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close((error) => {
				if (error) reject(error);
				else resolve(port);
			});
		});
		server.on("error", reject);
	});
}

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (fs.existsSync(filePath)) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for file: ${filePath}`);
}

async function captureFreshTokenBundle(): Promise<ClaudeCodeTokenBundle> {
	await ensureClaudeSubscriptionAuth(false);

	const port = await getFreePort();
	const caDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-claude-code-subscription-provider-ca-"));
	const proxy = new Proxy();
	const proxyHost = "127.0.0.1";
	const proxyUrl = `http://${proxyHost}:${port}`;
	const caPath = path.join(caDir, "certs", "ca.pem");
	let captured: ClaudeCodeTokenBundle | null = null;
	let settled = false;

	const bundlePromise = new Promise<ClaudeCodeTokenBundle>((resolve, reject) => {
		proxy.onError((_ctx: unknown, error: Error) => {
			if (!settled && error) {
				// Ignore noisy tunnel resets; actual failure will come from timeout/child exit.
			}
		});

		proxy.onRequest((ctx: any, callback: () => void) => {
			try {
				const host = getHeader(ctx?.clientToProxyRequest?.headers, "host");
				const url = String(ctx?.clientToProxyRequest?.url || "");
				const authHeader = getHeader(ctx?.clientToProxyRequest?.headers, "authorization");
				if (host === "api.anthropic.com" && url.startsWith("/v1/messages") && authHeader?.startsWith("Bearer ")) {
					captured = {
						accessToken: authHeader.slice("Bearer ".length),
						capturedAt: Date.now(),
						expiresAt: Date.now() + TOKEN_TTL_MS,
						anthropicBeta: getHeader(ctx.clientToProxyRequest.headers, "anthropic-beta"),
						userAgent: getHeader(ctx.clientToProxyRequest.headers, "user-agent"),
						xApp: getHeader(ctx.clientToProxyRequest.headers, "x-app"),
					};
					if (!settled) {
						settled = true;
						resolve(captured);
					}
				}
			} finally {
				callback();
			}
		});

		proxy.listen({ host: proxyHost, port, sslCaDir: caDir }, (error: Error | undefined) => {
			if (error && !settled) {
				settled = true;
				reject(error);
			}
		});
	});

	await waitForFile(caPath);

	const child = spawn(
		"claude",
		["--model", CAPTURE_ANTHROPIC_MODEL, "--print", CAPTURE_PROMPT],
		{
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				HTTP_PROXY: proxyUrl,
				HTTPS_PROXY: proxyUrl,
				NODE_EXTRA_CA_CERTS: caPath,
			},
		},
	);

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});

	const exitPromise = (async () => {
		const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
		if (captured) return captured;
		throw new Error(
			`Claude Code exited before token capture (${code ?? "unknown"}${signal ? `, ${signal}` : ""}). ${stderr || stdout}`,
		);
	})();

	const timeoutPromise = new Promise<ClaudeCodeTokenBundle>((_, reject) => {
		setTimeout(() => {
			reject(new Error(`Timed out waiting for Claude Code token capture after ${CAPTURE_TIMEOUT_MS}ms.`));
		}, CAPTURE_TIMEOUT_MS);
	});

	const originalConsoleLog = console.log;
	const originalConsoleWarn = console.warn;
	const originalStdoutWrite = process.stdout.write.bind(process.stdout);
	const originalStderrWrite = process.stderr.write.bind(process.stderr);
	console.log = () => {};
	console.warn = () => {};
	(process.stdout.write as unknown as (...args: any[]) => boolean) = (() => true) as any;
	(process.stderr.write as unknown as (...args: any[]) => boolean) = (() => true) as any;
	try {
		const bundle = await Promise.race([bundlePromise, exitPromise, timeoutPromise]);
		return {
			...bundle,
			anthropicBeta: normalizeAnthropicBeta(bundle.anthropicBeta),
			userAgent: bundle.userAgent || DEFAULT_USER_AGENT,
			xApp: bundle.xApp || DEFAULT_X_APP,
		};
	} finally {
		try {
			if (child.exitCode == null && child.signalCode == null) {
				child.kill("SIGTERM");
				const exited = await Promise.race([
					once(child, "exit").then(() => true),
					new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
				]);
				if (!exited) {
					child.kill("SIGKILL");
					await Promise.race([
						once(child, "exit").catch(() => undefined),
						new Promise((resolve) => setTimeout(resolve, 1000)),
					]);
				}
			}
		} catch {}
		await Promise.race([
			new Promise<void>((resolve) => {
				try {
					proxy.close(() => resolve());
				} catch {
					resolve();
				}
			}),
			new Promise<void>((resolve) => setTimeout(resolve, 1000)),
		]);
		await fsp.rm(caDir, { recursive: true, force: true });
		console.log = originalConsoleLog;
		console.warn = originalConsoleWarn;
		(process.stdout.write as unknown as (...args: any[]) => boolean) = originalStdoutWrite as any;
		(process.stderr.write as unknown as (...args: any[]) => boolean) = originalStderrWrite as any;
	}
}

async function getTokenBundle(forceRefresh = false): Promise<ClaudeCodeTokenBundle> {
	if (!forceRefresh) {
		const cached = await readTokenCache();
		if (isCacheFresh(cached)) {
			return {
				...cached,
				anthropicBeta: normalizeAnthropicBeta(cached.anthropicBeta),
				userAgent: cached.userAgent || DEFAULT_USER_AGENT,
				xApp: cached.xApp || DEFAULT_X_APP,
			};
		}
	}

	if (inflightTokenRefresh) {
		return inflightTokenRefresh;
	}

	inflightTokenRefresh = (async () => {
		const bundle = await captureFreshTokenBundle();
		await writeTokenCache(bundle);
		return bundle;
	})();

	try {
		return await inflightTokenRefresh;
	} finally {
		inflightTokenRefresh = null;
	}
}

function providerHeaders(bundle: ClaudeCodeTokenBundle, modelId: string): Record<string, string> {
	return {
		"anthropic-beta": betaHeaderForModel(modelId),
		"user-agent": bundle.userAgent || DEFAULT_USER_AGENT,
		"x-app": bundle.xApp || DEFAULT_X_APP,
		"x-claude-code-session-id": randomUUID(),
		"x-client-request-id": randomUUID(),
	};
}

function toAnthropicModel(model: Model<Api>): Model<"anthropic-messages"> {
	return {
		...model,
		api: "anthropic-messages",
		id: ANTHROPIC_ID_BY_MODEL_ID.get(model.id) ?? model.id,
		// pi-ai 0.77 reads compat.forceAdaptiveThinking from the model to decide
		// whether to send `thinking.type: "adaptive"` + `output_config.effort`.
		// Every model this provider exposes (Opus 4.6/4.7/4.8, Sonnet 4.6) uses the
		// adaptive thinking format, so force it regardless of the remapped id.
		compat: {
			...((model as Model<"anthropic-messages">).compat ?? {}),
			forceAdaptiveThinking: true,
		},
	} as Model<"anthropic-messages">;
}

async function pipeAttempt(
	outer: AssistantMessageEventStream,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	attempt: number,
): Promise<"done" | "retry"> {
	const bundle = await getTokenBundle(attempt > 0);
	const inner = streamSimpleAnthropic(toAnthropicModel(model), context, {
		...options,
		maxTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
		apiKey: bundle.accessToken,
		headers: {
			...providerHeaders(bundle, model.id),
			...(options?.headers || {}),
		},
		onPayload: async (payload, payloadModel) => {
			const callerPayload = await options?.onPayload?.(payload, payloadModel);
			return rewriteClaudeCodePayload(callerPayload ?? payload);
		},
	});

	let bufferedStart: AssistantMessageEvent | null = null;
	let emittedVisibleEvent = false;

	for await (const event of inner) {
		if (!emittedVisibleEvent) {
			if (event.type === "start") {
				bufferedStart = event;
				continue;
			}

			if (event.type === "error" && isAuthenticationError(event.error.errorMessage) && attempt === 0) {
				await clearTokenCache();
				return "retry";
			}

			if (bufferedStart) outer.push(bufferedStart);
			emittedVisibleEvent = true;
		}

		outer.push(event);
		if (event.type === "done" || event.type === "error") {
			outer.end();
			return "done";
		}
	}

	if (bufferedStart && !emittedVisibleEvent) {
		outer.push(bufferedStart);
	}
	const error = createProviderError(model, "Claude Code provider ended without a terminal event.");
	outer.push({ type: "error", reason: "error", error });
	outer.end();
	return "done";
}

function streamClaudeCodeProvider(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const outer = createAssistantMessageEventStream();

	void (async () => {
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				const outcome = await pipeAttempt(outer, model, context, options, attempt);
				if (outcome === "done") return;
			}
		} catch (error) {
			const message = createProviderError(
				model,
				error instanceof Error ? error.message : String(error),
				options?.signal?.aborted,
			);
			outer.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
			outer.end();
		}
	})();

	return outer;
}

function formatCacheAge(bundle: ClaudeCodeTokenBundle | null): string {
	if (!bundle) return "no cached token";
	const ageSeconds = Math.max(0, Math.floor((Date.now() - bundle.capturedAt) / 1000));
	const expiresInSeconds = Math.max(0, Math.floor((bundle.expiresAt - Date.now()) / 1000));
	return `cached ${ageSeconds}s ago, expires in ${expiresInSeconds}s`;
}

export default function registerClaudeCodeProvider(pi: ExtensionAPI) {
	pi.registerProvider(CLAUDE_CODE_PROVIDER, {
		baseUrl: "https://api.anthropic.com",
		apiKey: "claude-code-bootstrap",
		api: "claude-code-anthropic",
		models: CLAUDE_CODE_MODELS.map((model): ProviderModelConfig => ({
			id: model.id,
			name: model.name,
			reasoning: true,
			input: ["text", "image"],
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			thinkingLevelMap: model.thinkingLevelMap,
		})),
		streamSimple: streamClaudeCodeProvider,
	});

	pi.registerCommand("claude-code-auth", {
		description: "Check or refresh the cached Claude Code access token",
		handler: async (args, ctx) => {
			const refresh = args.trim() === "refresh";
			const status = await runClaudeAuthStatus().catch(() => ({} as ClaudeAuthStatus));
			if (!refresh) {
				const cached = await readTokenCache();
				ctx.ui.notify(
					`Claude Code auth: ${status.loggedIn ? `${status.authMethod ?? "unknown"}/${status.subscriptionType ?? "unknown"}` : "not logged in"}; ${formatCacheAge(cached)}`,
					"info",
				);
				return;
			}

			try {
				const bundle = await getTokenBundle(true);
				ctx.ui.notify(
					`Refreshed Claude Code token (${formatCacheAge(bundle)}). Models: ${CLAUDE_CODE_MODELS.map((m) => m.id).join(", ")}`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

export {
	CAPTURE_PROMPT,
	CLAUDE_CODE_MODELS,
	CLAUDE_CODE_PROVIDER,
	DEFAULT_MODEL_ID,
	captureFreshTokenBundle,
	getTokenBundle,
	streamClaudeCodeProvider,
};
