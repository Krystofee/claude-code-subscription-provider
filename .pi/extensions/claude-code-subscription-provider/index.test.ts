import assert from "node:assert/strict";
import test from "node:test";
import { isAuthenticationError } from "./index.ts";

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
