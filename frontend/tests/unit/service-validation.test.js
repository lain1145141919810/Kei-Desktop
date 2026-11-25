"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeServerDefinition, sanitizeToolCall, sanitizeTaskRequest, checkServerId } = require("../../src/main/service-validation");

test("stdio server definition keeps only known fields and reference names", () => {
    const { def } = sanitizeServerDefinition({ name: " Local ", transport: "stdio", command: "/usr/bin/python3", args: ["s.py", "stdio"],
        timeoutSeconds: "5", readOnlyTools: ["echo", "echo"], credentialRef: { env: "MY_TOKEN", target: "TOOL_TOKEN" }, secret: "x" });
    assert.deepEqual(def, { name: "Local", transport: "stdio", enabled: true, timeoutSeconds: 5, protocolMode: "auto",
        readOnlyTools: ["echo"], credentialRef: { env: "MY_TOKEN", target: "TOOL_TOKEN" }, command: "/usr/bin/python3", args: ["s.py", "stdio"] });
});

test("credential references must be environment variable names, not values", () => {
    assert.equal(sanitizeServerDefinition({ name: "x", transport: "stdio", command: "c", credentialRef: { env: "Bearer abc.def" } }).error, "invalid_credential_ref");
    assert.equal(sanitizeServerDefinition({ name: "x", transport: "streamable-http", url: "https://h/mcp", credentialRef: { env: "T", target: "U" } }).error, "invalid_credential_ref");
});

test("HTTP URLs: no userinfo; credentials need HTTPS or loopback", () => {
    assert.equal(sanitizeServerDefinition({ name: "x", transport: "streamable-http", url: "https://u:p@h/mcp" }).error, "credential_in_url");
    assert.equal(sanitizeServerDefinition({ name: "x", transport: "streamable-http", url: "http://example.com/mcp", credentialRef: { env: "T" } }).error, "insecure_credential_url");
    assert.ok(sanitizeServerDefinition({ name: "x", transport: "streamable-http", url: "http://127.0.0.1:8001/mcp", credentialRef: { env: "T" } }).def);
    assert.ok(sanitizeServerDefinition({ name: "x", transport: "streamable-http", url: "https://example.com/mcp", credentialRef: { env: "T" } }).def);
    assert.equal(sanitizeServerDefinition({ name: "x", transport: "streamable-http", url: "file:///etc/passwd" }).error, "invalid_url");
});

test("timeouts are 1-60 seconds and transports are restricted", () => {
    assert.equal(sanitizeServerDefinition({ name: "x", transport: "stdio", command: "c", timeoutSeconds: 61 }).error, "invalid_timeout");
    assert.equal(sanitizeServerDefinition({ name: "x", transport: "sse", command: "c" }).error, "invalid_transport");
});

test("tool calls validate server id, tool name and object arguments; extra fields are not forwarded", () => {
    assert.deepEqual(sanitizeToolCall("a", "echo", { key: "k" }), { call: { serverId: "a", toolName: "echo", arguments: { key: "k" } } });
    assert.equal(sanitizeToolCall("A B", "echo", {}).error, "invalid_request");
    assert.equal(sanitizeToolCall("a", "echo", []).error, "invalid_arguments");
    assert.equal(checkServerId("../x"), false);
});

test("task requests: executor must exist and be available; model must be advertised", () => {
    const executors = [
        { id: "dsh", available: true, options: { models: [{ id: "flash" }] } },
        { id: "studio.missing", available: false, reason: "cli_missing" },
    ];
    assert.equal(sanitizeTaskRequest(executors, "studio.missing", "x").error, "cli_missing");
    assert.equal(sanitizeTaskRequest(executors, "nope.x", "x").error, "executor_not_found");
    assert.equal(sanitizeTaskRequest(executors, "dsh", "   ").error, "invalid_task_input");
    assert.equal(sanitizeTaskRequest(executors, "dsh", "go", { model: "pro" }).error, "invalid_options");
    assert.deepEqual(sanitizeTaskRequest(executors, "dsh", " go ", { model: "flash" }).options, { model: "flash" });
});
