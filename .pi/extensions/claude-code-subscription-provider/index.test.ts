import assert from "node:assert/strict";
import test from "node:test";
import {
	CLAUDE_CODE_MODELS,
	isAuthenticationError,
	normalizeClaudeCodeUserAgent,
} from "./index.ts";

test("treats rotated Claude Code token errors as authentication errors", () => {
	assert.equal(
		isAuthenticationError(
			'403 {"error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization.","details":{"error_code":"oauth_not_allowed_for_organization"}}}',
		),
		true,
	);
});

test("does not retry unrelated permission errors", () => {
	assert.equal(isAuthenticationError("403 permission_error: model access denied"), false);
});

test("upgrades cached user agents too old for Fable 5.1", () => {
	assert.equal(
		normalizeClaudeCodeUserAgent("claude-cli/2.1.169 (external, sdk-cli)"),
		"claude-cli/2.1.251 (external, sdk-cli)",
	);
	assert.equal(
		normalizeClaudeCodeUserAgent("claude-cli/2.1.258 (external, sdk-cli)"),
		"claude-cli/2.1.258 (external, sdk-cli)",
	);
});

test("exposes Fable 5.1 with its Anthropic model id and pricing", () => {
	const model = CLAUDE_CODE_MODELS.find((candidate) => candidate.id === "fable-5-1");

	assert.deepEqual(model, {
		id: "fable-5-1",
		anthropicId: "claude-fable-5-1",
		name: "Claude Code Subscription Provider / Fable 5.1 (1M)",
		cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		thinkingLevelMap: { xhigh: "xhigh" },
	});
});
