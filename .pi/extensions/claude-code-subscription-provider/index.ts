import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	createAssistantMessageEventStream,
	anthropicMessagesApi,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type TranscriptContext,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

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
	authFingerprint?: string;
};

const CLAUDE_CODE_PROVIDER = "claude-code-subscription-provider";

// Subscription context limits differ from the API catalog (notably Sonnet).
// Keep those explicit, but inherit API capabilities and thinking levels from Pi.
type ClaudeCodeModelDef = {
	id: string;
	anthropicId: string;
	name: string;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	compat?: Model<"anthropic-messages">["compat"];
	promptCache?: Model<Api>["promptCache"];
};

const CLAUDE_CODE_MODEL_DEFS = [
	{
		id: "opus-5-5",
		anthropicId: "claude-opus-5-5",
		name: "Claude Code Subscription Provider / Opus 5.5 (1M)",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "opus-5",
		anthropicId: "claude-opus-5",
		name: "Claude Code Subscription Provider / Opus 5 (1M)",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "opus-4-8",
		anthropicId: "claude-opus-4-8",
		name: "Claude Code Subscription Provider / Opus 4.8 (1M)",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "opus-4-7",
		anthropicId: "claude-opus-4-7",
		name: "Claude Code Subscription Provider / Opus 4.7 (1M)",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "opus-4-6",
		anthropicId: "claude-opus-4-6",
		name: "Claude Code Subscription Provider / Opus 4.6 (1M)",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "sonnet-4-6",
		anthropicId: "claude-sonnet-4-6",
		name: "Claude Code Subscription Provider / Sonnet 4.6 (256k)",
		// Subscription tier caps Sonnet at 256k context (1M requires usage credits).
		contextWindow: 256_000,
		maxTokens: 64_000,
	},
	{
		id: "fable-5-1",
		anthropicId: "claude-fable-5-1",
		name: "Claude Code Subscription Provider / Fable 5.1 (1M)",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "fable-5",
		anthropicId: "claude-fable-5",
		name: "Claude Code Subscription Provider / Fable 5 (1M)",
		// Mythos-class model (above Opus); the launch post describes staying focused
		// across millions of tokens, so treat it like Opus with a 1M window. NOTE: I
		// couldn't verify the 1M long-context tier on the subscription right now
		// because Fable is broadly rate-limited at launch (429 on every call). If
		// small prompts start 429ing once limits ease, the 1M tier isn't included on
		// subscription — drop contextWindow below 1M so the 1M beta is omitted (as
		// with sonnet-4-6).
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
];

const nativeModels = new Map(getBuiltinModels("anthropic").map((model) => [model.id, model]));
const CLAUDE_CODE_MODELS: ClaudeCodeModelDef[] = CLAUDE_CODE_MODEL_DEFS.map((model) => {
	const native = nativeModels.get(model.anthropicId);
	if (!native) throw new Error(`Pi's Anthropic catalog is missing ${model.anthropicId}. Update Pi.`);
	return {
		...model,
		cost: native.cost,
		thinkingLevelMap: native.thinkingLevelMap,
		promptCache: native.promptCache,
		// Fallbacks need subscription availability checks; don't silently request API-only models.
		compat: { ...native.compat, allowedFallbackModels: undefined },
	};
});

const ANTHROPIC_ID_BY_MODEL_ID = new Map(
	CLAUDE_CODE_MODELS.map((model): [string, string] => [model.id, model.anthropicId]),
);

// Model used for the auth-capture probe and status text. The probe only needs a
// valid model so `claude` emits a request we can sniff the bearer token from —
// any subscription model works, so we pin it to the default.
const DEFAULT_MODEL_ID = "opus-4-8";
const CAPTURE_ANTHROPIC_MODEL = ANTHROPIC_ID_BY_MODEL_ID.get(DEFAULT_MODEL_ID) ?? "claude-opus-4-8";
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
const CAPTURE_TIMEOUT_MS = 90 * 1000;
const CACHE_FILE = path.join(
	process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
	"cache", "claude-code-subscription-provider.json",
);
const CAPTURE_SCRIPT = fileURLToPath(new URL("../../../src/claude-network-interceptor.js", import.meta.url));
const DEFAULT_SESSION_ID = randomUUID();
// Bumped for Opus 5.5: older user agents get a 400 claude_code_version_too_old
// ("Claude Code 2.1.251 does not support this model; version 2.1.280 or newer is
// required"), so cached UAs below this are rewritten before we send them.
const MINIMUM_CLAUDE_CODE_VERSION = [2, 1, 280] as const;
const DEFAULT_USER_AGENT = "claude-cli/2.1.280 (external, sdk-cli)";
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

let inflightTokenRefresh: {
	promise: Promise<ClaudeCodeTokenBundle>;
	controller: AbortController;
	waiters: number;
	authFingerprint?: string;
} | null = null;

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		void promise.catch(() => {});
		signal.throwIfAborted();
	}
	let onAbort: () => void = () => {};
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(signal.reason ?? new Error("Request aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

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

function normalizeClaudeCodeUserAgent(value?: string): string {
	const match = value?.match(/claude-cli\/(\d+)\.(\d+)\.(\d+)/);
	if (!value || !match) return DEFAULT_USER_AGENT;

	const version = match.slice(1).map(Number);
	for (let i = 0; i < MINIMUM_CLAUDE_CODE_VERSION.length; i++) {
		if (version[i] > MINIMUM_CLAUDE_CODE_VERSION[i]) return value;
		if (version[i] < MINIMUM_CLAUDE_CODE_VERSION[i]) return DEFAULT_USER_AGENT;
	}
	return value;
}

function betaHeaderForModel(model: Model<Api>, extra?: string): string {
	const betas = MODEL_IDS_WITH_1M.has(model.id)
		? [...REQUIRED_BETAS]
		: REQUIRED_BETAS.filter((beta) => beta !== CONTEXT_1M_BETA);
	const compat = (model as Model<"anthropic-messages">).compat;
	if (compat?.supportsMidConvoEffort) {
		betas.push("mid-conversation-output-config-2026-07-01", "thinking-binding-controls-2026-08-01");
	}
	if (compat?.supportsMidConvoToolChanges) betas.push("inline-tools-2026-09-15");
	return [...new Set([...betas, ...splitBetas(extra)])].join(",");
}

function buildBillingHeader(sessionId: string): string {
	// A changing system prefix invalidates signed thinking replay and prompt caches.
	const cch = 10000 + (parseInt(createHash("sha256").update(sessionId).digest("hex").slice(0, 8), 16) % 90000);
	return `x-anthropic-billing-header: cc_version=2.1.280.714; cc_entrypoint=sdk-cli; cch=${cch};`;
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
	if (typeof system === "string") system = [{ type: "text", text: system }];
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

function normalizeHiddenThinking(payload: Record<string, unknown>) {
	const model = typeof payload.model === "string" ? payload.model : "";
	// Opus 4.7+ and Fable 5+ default thinking.display to "omitted", which makes
	// thinking_delta events empty (only signature_delta is sent). Explicitly opt in
	// to summarized thinking so users see reasoning in the UI, matching Opus 4.6.
	// https://platform.claude.com/docs/en/about-claude/models/migration-guide#migrating-to-claude-opus-4-7
	const hidesThinkingByDefault =
		model.includes("opus-4-7") ||
		model.includes("opus-4.7") ||
		model.includes("opus-4-8") ||
		model.includes("opus-4.8") ||
		model.includes("opus-5") ||
		model.includes("fable-5") ||
		model.includes("fable5");
	if (!hidesThinkingByDefault) return;

	const thinking = payload.thinking;
	if (thinking && typeof thinking === "object" && (thinking as Record<string, unknown>).type === "adaptive") {
		const thinkingObj = { ...(thinking as Record<string, unknown>) };
		if (thinkingObj.display == null) {
			thinkingObj.display = "summarized";
		}
		payload.thinking = thinkingObj;
	}
}

function rewriteClaudeCodePayload(payload: unknown, sessionId: string = DEFAULT_SESSION_ID): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const next = structuredClone(payload as Record<string, unknown>);
	const reminderBlocks = extractSystemReminderBlocks(next.system);
	next.system = [
		{ type: "text", text: buildBillingHeader(sessionId) },
		{ type: "text", text: CLAUDE_CODE_SDK_SYSTEM_TEXT },
	];
	next.messages = injectSystemRemindersIntoMessages(next.messages, reminderBlocks);
	if (next.context_management == null) {
		next.context_management = structuredClone(CLAUDE_CODE_CONTEXT_MANAGEMENT);
	}
	normalizeHiddenThinking(next);
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
		if (typeof parsed?.accessToken !== "string" || !Number.isFinite(parsed.expiresAt) || !Number.isFinite(parsed.capturedAt)) return null;
		return parsed;
	} catch {
		return null;
	}
}

async function writeTokenCache(bundle: ClaudeCodeTokenBundle): Promise<void> {
	await ensureDir(CACHE_FILE);
	const temporary = `${CACHE_FILE}.${randomUUID()}.tmp`;
	try {
		await fsp.writeFile(temporary, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await fsp.rename(temporary, CACHE_FILE);
	} finally {
		await fsp.rm(temporary, { force: true });
	}
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

async function runJsonCommand<T>(
	command: string, args: string[], signal?: AbortSignal, timeoutMs = 15_000,
	env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
	signal?.throwIfAborted();
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
		let stdout = "";
		let stopped = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const stop = (error: unknown) => {
			if (stopped) return;
			stopped = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
			killTimer.unref();
			reject(error);
		};
		const onAbort = () => stop(signal?.reason ?? new Error("Request aborted"));
		const timer = setTimeout(() => stop(new Error(`${command} timed out after ${timeoutMs}ms.`)), timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
			if (stdout.length > 64_000) stop(new Error(`${command} returned too much output.`));
		});
		// The capture worker owns proxy debug output. Never replay its raw logs or tokens in Pi.
		child.stderr.resume();
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			signal?.removeEventListener("abort", onAbort);
			if (stopped) return;
			if (code !== 0) {
				reject(new Error(`${command} failed (${code ?? "signal"}). Check Claude Code login and connectivity.`));
				return;
			}
			try { resolve(JSON.parse(stdout) as T); }
			catch { reject(new Error(`${command} returned invalid JSON.`)); }
		});
	});
}

async function runClaudeAuthStatus(signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<ClaudeAuthStatus> {
	return runJsonCommand("claude", ["auth", "status"], signal, 15_000, env);
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
		value.includes("access token") ||
		value.includes("oauth_not_allowed_for_organization") ||
		value.includes("oauth authentication is currently not allowed for this organization")
	);
}

async function captureFreshTokenBundle(signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<ClaudeCodeTokenBundle> {
	const status = await runClaudeAuthStatus(signal, env);
	if (!status.loggedIn || !["claude.ai", "oauth_token"].includes(status.authMethod ?? "")) {
		throw new Error(buildLoginHint(status));
	}
	// The MITM library writes directly to console. Isolate it in a worker rather
	// than muting Pi's global stdout/stderr while other requests and tools run.
	const captured = await runJsonCommand<ClaudeCodeTokenBundle>(
		process.execPath, [CAPTURE_SCRIPT, "--capture-token", "--model", CAPTURE_ANTHROPIC_MODEL],
		signal, CAPTURE_TIMEOUT_MS + 5_000, env,
	);
	if (typeof captured.accessToken !== "string" || !captured.accessToken.startsWith("sk-ant-oat")) {
		throw new Error("Claude Code did not return an OAuth access token.");
	}
	return {
		...captured,
		capturedAt: Date.now(),
		expiresAt: Date.now() + TOKEN_TTL_MS,
		anthropicBeta: normalizeAnthropicBeta(captured.anthropicBeta),
		userAgent: normalizeClaudeCodeUserAgent(captured.userAgent),
		xApp: captured.xApp || DEFAULT_X_APP,
	};
}

async function getTokenBundle(forceRefresh = false, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<ClaudeCodeTokenBundle> {
	signal?.throwIfAborted();
	const authFingerprint = env.CLAUDE_CODE_OAUTH_TOKEN
		? createHash("sha256").update(env.CLAUDE_CODE_OAUTH_TOKEN).digest("hex") : undefined;
	if (!forceRefresh) {
		const cached = await readTokenCache();
		signal?.throwIfAborted();
		if (isCacheFresh(cached) && cached.authFingerprint === authFingerprint) {
			return {
				...cached,
				anthropicBeta: normalizeAnthropicBeta(cached.anthropicBeta),
				userAgent: normalizeClaudeCodeUserAgent(cached.userAgent),
				xApp: cached.xApp || DEFAULT_X_APP,
			};
		}
	}

	if (inflightTokenRefresh && inflightTokenRefresh.authFingerprint !== authFingerprint) {
		await withAbort(inflightTokenRefresh.promise.catch(() => undefined), signal);
		return getTokenBundle(forceRefresh, signal, env);
	}
	if (!inflightTokenRefresh) {
		const controller = new AbortController();
		const refresh = { controller, waiters: 0, authFingerprint, promise: Promise.resolve({} as ClaudeCodeTokenBundle) };
		inflightTokenRefresh = refresh;
		refresh.promise = (async () => {
			try {
				const bundle = { ...await captureFreshTokenBundle(controller.signal, env), authFingerprint };
				controller.signal.throwIfAborted();
				await writeTokenCache(bundle);
				return bundle;
			} finally {
				if (inflightTokenRefresh === refresh) inflightTokenRefresh = null;
			}
		})();
	}
	const refresh = inflightTokenRefresh;
	refresh.waiters++;
	try {
		return await withAbort(refresh.promise, signal);
	} finally {
		// Cancelling a cache warmer must not abort a foreground request's refresh.
		if (--refresh.waiters === 0 && inflightTokenRefresh === refresh) {
			inflightTokenRefresh = null;
			refresh.controller.abort();
		}
	}
}

function providerHeaders(bundle: ClaudeCodeTokenBundle, model: Model<Api>, sessionId: string, extraBetas?: string): Record<string, string> {
	return {
		"anthropic-beta": betaHeaderForModel(model, extraBetas),
		"user-agent": normalizeClaudeCodeUserAgent(bundle.userAgent),
		"x-app": bundle.xApp || DEFAULT_X_APP,
		"x-claude-code-session-id": sessionId,
		"x-client-request-id": randomUUID(),
	};
}

function toAnthropicModel(model: Model<Api>): Model<"anthropic-messages"> {
	return {
		...model,
		api: "anthropic-messages",
		id: ANTHROPIC_ID_BY_MODEL_ID.get(model.id) ?? model.id,
		// All exposed models use adaptive rather than budget-based thinking.
		compat: {
			...((model as Model<"anthropic-messages">).compat ?? {}),
			forceAdaptiveThinking: true,
		},
	} as Model<"anthropic-messages">;
}

async function pipeAttempt(
	outer: AssistantMessageEventStream,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	attempt: number,
	loadToken: typeof getTokenBundle,
): Promise<"done" | "retry"> {
	options?.signal?.throwIfAborted();
	const bundle = await loadToken(attempt > 0, options?.signal, { ...process.env, ...options?.env });
	options?.signal?.throwIfAborted();
	const sessionId = options?.sessionId ?? DEFAULT_SESSION_ID;
	const transcript: TranscriptContext = {
		...context,
		messages: context.messages.map((message) => message.role === "assistant" && message.provider === model.provider
			? { ...message, api: "anthropic-messages", model: ANTHROPIC_ID_BY_MODEL_ID.get(message.model) ?? message.model }
			: message),
	};
	const headers = { ...options?.headers, ...providerHeaders(bundle, model, sessionId, getHeader(options?.headers, "anthropic-beta")) };
	// Branch summaries omit reasoning entirely. Always-on models still need
	// adaptive thinking; low effort keeps these bounded, one-off requests cheap.
	const reasoning = options?.reasoning ?? (model.thinkingLevelMap?.off === null ? "low" : undefined);
	const inner = anthropicMessagesApi().streamSimple(toAnthropicModel(model), transcript, {
		...options,
		reasoning,
		maxTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
		apiKey: bundle.accessToken,
		headers,
		onPayload: async (payload) => {
			const rewritten = rewriteClaudeCodePayload(payload, sessionId);
			return await options?.onPayload?.(rewritten, model) ?? rewritten;
		},
		onResponse: options?.onResponse ? (response) => options.onResponse!(response, model) : undefined,
		onProviderStreamEvent: options?.onProviderStreamEvent ? (event) => options.onProviderStreamEvent!(event, model) : undefined,
	});

	let bufferedStart: AssistantMessageEvent | null = null;
	let emittedVisibleEvent = false;

	for await (const event of inner) {
		// Persist Pi-facing IDs so tree navigation, resuming and model attribution
		// can resolve the response. Translate them back only for signed replay.
		const message = "partial" in event ? event.partial : event.type === "done" ? event.message : event.type === "error" ? event.error : undefined;
		if (message) { message.api = model.api; message.model = model.id; }
		if (!emittedVisibleEvent) {
			if (event.type === "start") {
				bufferedStart = event;
				continue;
			}

			if (event.type === "error" && isAuthenticationError(event.error.errorMessage) && attempt === 0) {
				options?.signal?.throwIfAborted();
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
	context: TranscriptContext,
	options?: SimpleStreamOptions,
	loadToken = getTokenBundle,
): AssistantMessageEventStream {
	const outer = createAssistantMessageEventStream();

	void (async () => {
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				const outcome = await pipeAttempt(outer, model, context, options, attempt, loadToken);
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
			compat: model.compat,
			promptCache: model.promptCache,
		})),
		streamSimple: streamClaudeCodeProvider,
	});

	pi.registerCommand("claude-code-auth", {
		description: "Check, refresh or clear the cached Claude Code access token",
		handler: async (args, ctx) => {
			if (args.trim() === "clear") {
				const refresh = inflightTokenRefresh;
				refresh?.controller.abort();
				await refresh?.promise.catch(() => {});
				await clearTokenCache();
				ctx.ui.notify("Cleared Claude Code token cache.", "info");
				return;
			}
			const refresh = args.trim() === "refresh";
			if (!refresh) {
				const status = await runClaudeAuthStatus().catch(() => ({} as ClaudeAuthStatus));
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
	CLAUDE_CODE_MODELS,
	CLAUDE_CODE_PROVIDER,
	DEFAULT_MODEL_ID,
	captureFreshTokenBundle,
	getTokenBundle,
	isAuthenticationError,
	normalizeClaudeCodeUserAgent,
	rewriteClaudeCodePayload,
	runJsonCommand,
	streamClaudeCodeProvider,
};
