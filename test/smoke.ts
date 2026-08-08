/**
 * Smoke + mocked gateway tests for opencode-commandcode.
 * Covers attachments, tools/MCP park-resume, compact, and usage — no live API required.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

async function main() {
  const {
    listCommandAuthCandidates,
    parseAuthFile,
    extractApiKeyFromAuthFile,
    readCommandCodeApiKeyFromEnv,
  } = await import("../src/credentials.ts");
  const {
    COMMAND_CODE_MODELS,
    buildEffortVariants,
    getCommandModels,
    isLoginPlaceholderModel,
    resolveCommandModelId,
    findCommandModel,
  } = await import("../src/models.ts");
  const {
    encodeCommandModelSelection,
    decodeCommandModelSelection,
    resolveCommandModelSelection,
  } = await import("../src/model-selection.ts");
  const {
    isCommandEffort,
    PROVIDER_ID,
    EFFORT_LEVELS,
    LAGUNA_MODEL_ID,
    DEFAULT_MODEL_ID,
  } = await import("../src/constants.ts");
  const { CommandCodePlugin } = await import("../src/index.ts");
  const {
    startProxy,
    stopProxy,
    getProxyPort,
    getCommandProxyBaseUrl,
    setStreamGenerateForTests,
  } = await import("../src/proxy.ts");
  const {
    openaiContentToUserParts,
    openaiMessagesToWire,
    openaiToolsToWire,
    contentHasAttachments,
  } = await import("../src/prompt.ts");
  const {
    assessContext,
    compactWireMessages,
    estimateMessageTokens,
  } = await import("../src/compact.ts");
  const {
    resetUsageStore,
    recordTurnUsage,
    recordToolCall,
    getSessionUsage,
    totalUsageAcrossSessions,
    usageToOpenAI,
  } = await import("../src/usage.ts");
  const { mapStreamEvent, buildGenerateBody, buildAuthHeaders } = await import(
    "../src/gateway.ts"
  );
  const { detectCommandCode } = await import("../src/detect.ts");

  // --- credentials ---
  assert.ok(listCommandAuthCandidates().length > 0);
  assert.equal(
    extractApiKeyFromAuthFile(parseAuthFile(JSON.stringify({ apiKey: "k1" }))),
    "k1",
  );
  assert.equal(
    readCommandCodeApiKeyFromEnv({ COMMAND_CODE_API_KEY: " tok " }),
    "tok",
  );
  assert.equal(readCommandCodeApiKeyFromEnv({}), null);

  // --- models / Laguna ---
  const models = getCommandModels();
  assert.ok(models.some((m) => m.resolvedId === LAGUNA_MODEL_ID));
  assert.equal(resolveCommandModelId("laguna"), LAGUNA_MODEL_ID);
  assert.equal(resolveCommandModelId("laguna-s-2.1-free"), LAGUNA_MODEL_ID);
  assert.equal(resolveCommandModelId(DEFAULT_MODEL_ID), LAGUNA_MODEL_ID);
  assert.equal(isLoginPlaceholderModel("login"), true);
  const laguna = findCommandModel("laguna")!;
  assert.equal(laguna.vision, false);
  assert.equal(laguna.free, true);
  assert.equal(laguna.contextWindow, 256_000);

  const variants = buildEffortVariants(laguna);
  for (const level of EFFORT_LEVELS) {
    assert.ok(variants[level]);
    assert.equal(isCommandEffort(level), true);
  }
  assert.deepEqual(variants.none, { disabled: true });

  const selection = resolveCommandModelSelection("laguna", "high");
  const encoded = encodeCommandModelSelection(selection);
  const decoded = decodeCommandModelSelection(encoded);
  assert.equal(decoded?.modelId, LAGUNA_MODEL_ID);
  assert.equal(decoded?.effort, "high");

  // --- attachments (text-only Laguna strips images; files/pdfs inlined) ---
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const imageParts = openaiContentToUserParts(
    [
      { type: "text", text: "what color?" },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${png}` },
      },
    ],
    false,
  );
  assert.ok(imageParts.some((p) => p.type === "text"));
  assert.ok(
    imageParts.some(
      (p) => p.type === "text" && p.text.includes("image omitted"),
    ),
  );
  assert.equal(
    imageParts.some((p) => p.type === "image"),
    false,
  );

  const visionParts = openaiContentToUserParts(
    [
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${png}` },
      },
    ],
    true,
  );
  assert.ok(visionParts.some((p) => p.type === "image"));

  const textFileB64 = Buffer.from("hello from attachment\nline2", "utf8").toString(
    "base64",
  );
  const fileParts = openaiContentToUserParts(
    [
      {
        type: "file",
        file: {
          filename: "notes.txt",
          media_type: "text/plain",
          data: textFileB64,
        },
      },
    ],
    false,
  );
  assert.ok(
    fileParts.some(
      (p) => p.type === "text" && p.text.includes("hello from attachment"),
    ),
  );

  const pdfParts = openaiContentToUserParts(
    [
      {
        type: "input_file",
        filename: "doc.pdf",
        media_type: "application/pdf",
        data: Buffer.from("%PDF-1.4").toString("base64"),
      },
    ],
    false,
  );
  assert.ok(
    pdfParts.some((p) => p.type === "text" && p.text.includes("attached_pdf")),
  );

  assert.equal(
    contentHasAttachments([
      { type: "image_url", image_url: { url: "x" } },
    ]),
    true,
  );

  const wired = openaiMessagesToWire(
    [
      { role: "system", content: "be concise" },
      {
        role: "user",
        content: [
          { type: "text", text: "summarize" },
          {
            type: "file",
            file: {
              filename: "a.md",
              media_type: "text/markdown",
              data: Buffer.from("# Title").toString("base64"),
            },
          },
        ],
      },
    ],
    { vision: false },
  );
  assert.equal(wired.system, "be concise");
  assert.ok(wired.messages.length >= 1);

  const tools = openaiToolsToWire([
    {
      type: "function",
      function: {
        name: "bash",
        description: "run shell",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "mcp__filesystem__read",
        description: "mcp read",
        parameters: { type: "object", properties: {} },
      },
    },
  ]);
  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.name, "bash");

  // --- compact / context ---
  const adviceOk = assessContext(10_000, 256_000);
  assert.equal(adviceOk.tier, "ok");
  const adviceWarn = assessContext(210_000, 256_000);
  assert.equal(adviceWarn.tier, "warn");
  const adviceAuto = assessContext(240_000, 256_000);
  assert.equal(adviceAuto.shouldCompact, true);

  const longMsgs = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content:
      i % 2 === 0
        ? [{ type: "text" as const, text: `user ${i} ${"x".repeat(200)}` }]
        : [{ type: "text" as const, text: `asst ${i}` }],
  }));
  // insert tool results
  longMsgs.push({
    role: "tool" as const,
    content: [
      {
        type: "tool-result" as const,
        toolCallId: "c1",
        toolName: "bash",
        output: { type: "text" as const, value: "old result ".repeat(50) },
      },
    ],
  } as any);
  const compacted = compactWireMessages(longMsgs as any, {
    sessionId: "sess-compact",
    keepTurns: 10,
    keepToolResults: 0,
  });
  assert.equal(compacted.compacted, true);
  assert.ok(estimateMessageTokens(wired.messages) > 0);

  // --- usage + mcp accounting ---
  resetUsageStore();
  recordTurnUsage(
    "sess-1",
    LAGUNA_MODEL_ID,
    256_000,
    {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
    },
  );
  recordToolCall("sess-1", "bash");
  recordToolCall("sess-1", "bash");
  recordToolCall("sess-1", "mcp__filesystem__read");
  const snap = getSessionUsage("sess-1")!;
  assert.equal(snap.usage.inputTokens, 100);
  assert.equal(snap.tools.find((t) => t.name === "bash")?.calls, 2);
  assert.equal(snap.tools.find((t) => t.name === "mcp__filesystem__read")?.mcp, true);
  const openaiUsage = usageToOpenAI(totalUsageAcrossSessions());
  assert.equal(openaiUsage.prompt_tokens, 100);
  assert.equal(openaiUsage.completion_tokens, 50);

  // --- gateway helpers ---
  const headers = buildAuthHeaders({ apiKey: "test-key", sessionId: "s1" });
  assert.equal(headers.Authorization, "Bearer test-key");
  assert.equal(headers["x-session-id"], "s1");
  const body = buildGenerateBody({
    apiKey: "test-key",
    model: LAGUNA_MODEL_ID,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
  });
  assert.equal(body.params.model, LAGUNA_MODEL_ID);
  assert.equal(body.params.stream, true);

  assert.deepEqual(mapStreamEvent({ type: "text-delta", text: "Hi" }), {
    kind: "text",
    text: "Hi",
  });
  assert.equal(mapStreamEvent({ type: "tool-call", toolCallId: "t1", toolName: "bash", input: { command: "ls" } }).kind, "tool_call");
  assert.equal(
    mapStreamEvent({
      type: "finish",
      finishReason: "stop",
      totalUsage: { inputTokens: 1, outputTokens: 2 },
    }).kind,
    "finish",
  );

  // --- detect (CLI may be present in this env) ---
  const detection = await detectCommandCode();
  assert.ok(
    detection.status === "ready" ||
      detection.status === "needs-login" ||
      detection.status === "missing-cli",
  );

  // --- plugin export ---
  assert.equal(typeof CommandCodePlugin, "function");
  assert.equal(PROVIDER_ID, "command-code");

  // --- proxy health + mocked chat (text, tools, usage, attachments) ---
  await stopProxy();
  resetUsageStore();

  setStreamGenerateForTests(async function* (params) {
    // Simulate tool-call then finish on first turn with tools; plain text otherwise.
    const last = params.messages[params.messages.length - 1];
    const hasToolResult =
      last?.role === "tool" ||
      params.messages.some((m) => m.role === "tool");

    if (params.tools && params.tools.length > 0 && !hasToolResult) {
      yield {
        kind: "text",
        text: "Calling tool…",
      };
      yield {
        kind: "tool_call",
        id: "call_test_bash_1",
        name: "bash",
        arguments: JSON.stringify({ command: "echo hi" }),
      };
      yield {
        kind: "finish",
        finishReason: "tool_calls",
        usage: {
          inputTokens: 40,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
      return;
    }

    if (hasToolResult) {
      yield { kind: "text", text: "Tool said hi." };
      yield {
        kind: "finish",
        finishReason: "stop",
        usage: {
          inputTokens: 60,
          outputTokens: 8,
          cacheReadTokens: 4,
          cacheWriteTokens: 0,
        },
      };
      return;
    }

    // Attachment-aware reply
    const blob = JSON.stringify(params.messages);
    if (blob.includes("attached_file") || blob.includes("attached_pdf") || blob.includes("image omitted")) {
      yield { kind: "text", text: "Saw your attachment." };
    } else {
      yield { kind: "reasoning", text: "thinking…" };
      yield { kind: "text", text: "Laguna hello." };
    }
    yield {
      kind: "finish",
      finishReason: "stop",
      usage: {
        inputTokens: 25,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  });

  const port = await startProxy(async () => "test-api-key");
  assert.ok(port > 0);
  assert.equal(getProxyPort(), port);
  assert.ok(getCommandProxyBaseUrl().includes(String(port)));

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);

  const modelsRes = await fetch(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(modelsRes.status, 200);
  const modelsJson = (await modelsRes.json()) as { data: Array<{ id: string }> };
  assert.ok(modelsJson.data.some((m) => m.id.includes("laguna")));

  // Plain completion
  const chat1 = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-commandcode-session": "test-sess-plain",
    },
    body: JSON.stringify({
      model: "command-code/laguna-s-2.1-free",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "Say hi" }],
    }),
  });
  assert.equal(chat1.status, 200);
  const chat1Text = await chat1.text();
  assert.ok(chat1Text.includes("Laguna hello."));
  assert.ok(chat1Text.includes("usage"));
  assert.ok(chat1Text.includes("[DONE]"));

  // Attachment completion
  const chatAtt = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-commandcode-session": "test-sess-att",
    },
    body: JSON.stringify({
      model: "laguna",
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "read this" },
            {
              type: "file",
              file: {
                filename: "note.txt",
                media_type: "text/plain",
                data: Buffer.from("secret-note-content").toString("base64"),
              },
            },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${png}` },
            },
          ],
        },
      ],
    }),
  });
  assert.equal(chatAtt.status, 200);
  const attJson = (await chatAtt.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number };
  };
  assert.ok(attJson.choices[0]?.message.content.includes("attachment"));
  assert.ok(attJson.usage);

  // Tools park + resume
  const chatTools = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-commandcode-session": "test-sess-tools",
    },
    body: JSON.stringify({
      model: "laguna-s-2.1-free",
      stream: true,
      messages: [{ role: "user", content: "run echo" }],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "shell",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        },
        {
          type: "function",
          function: {
            name: "mcp__demo__ping",
            description: "mcp ping",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    }),
  });
  assert.equal(chatTools.status, 200);
  const toolsText = await chatTools.text();
  assert.ok(toolsText.includes("call_test_bash_1"));
  assert.ok(toolsText.includes("tool_calls") || toolsText.includes('"bash"'));

  const chatResume = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-commandcode-session": "test-sess-tools",
    },
    body: JSON.stringify({
      model: "laguna-s-2.1-free",
      stream: true,
      messages: [
        { role: "user", content: "run echo" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_test_bash_1",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command: "echo hi" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_test_bash_1",
          content: "hi",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "shell",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        },
      ],
    }),
  });
  assert.equal(chatResume.status, 200);
  const resumeText = await chatResume.text();
  assert.ok(resumeText.includes("Tool said hi."));

  // Usage endpoint
  const usageRes = await fetch(`http://127.0.0.1:${port}/v1/usage`);
  assert.equal(usageRes.status, 200);
  const usageJson = (await usageRes.json()) as {
    total: { prompt_tokens: number; completion_tokens: number };
    sessions: unknown[];
  };
  assert.ok(usageJson.total.prompt_tokens > 0);
  assert.ok(Array.isArray(usageJson.sessions));
  assert.ok(usageJson.sessions.length > 0);

  const sessUsage = await fetch(
    `http://127.0.0.1:${port}/v1/usage/session/test-sess-tools`,
  );
  assert.equal(sessUsage.status, 200);
  const sessJson = (await sessUsage.json()) as {
    tools: Array<{ name: string; mcp: boolean; calls: number }>;
  };
  assert.ok(sessJson.tools.some((t) => t.name === "bash"));

  await stopProxy();

  // TypeScript build
  const build = spawnSync("bun", ["run", "build"], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });
  if (build.status !== 0) {
    console.error(build.stdout);
    console.error(build.stderr);
    throw new Error("build failed");
  }

  console.log("ok — opencode-commandcode smoke tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
