import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { asSchema, generateText } from "ai";
import { MODEL_ENVIRONMENT_KEYS } from "./modelConfigHelpers";
import {
  createAIProvider,
  getAIProvider,
  getConfiguredAIModel,
  getNativeOpenAIModelId,
} from "./aiProvider";

beforeEach(() => {
  vi.stubEnv("AI_PROVIDER", "");
  vi.stubEnv("OPENAI_API_KEY", "test-only-openai-key");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  for (const key of MODEL_ENVIRONMENT_KEYS) vi.stubEnv(key, "");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request");
    })
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

test("default mode keeps OpenRouter and requires its own key", () => {
  expect(getAIProvider()).toBe("openrouter");
  expect(() => createAIProvider()).toThrow("Missing OPENROUTER_API_KEY");
  vi.stubEnv("OPENROUTER_API_KEY", "test-only-openrouter-key");
  const model = createAIProvider()("moonshotai/kimi-k2.6");
  expect(model.provider).toContain("openrouter");
  expect(model.modelId).toBe("moonshotai/kimi-k2.6");
});

test("native mode needs no OpenRouter key and normalizes OpenAI-prefixed models", () => {
  vi.stubEnv("AI_PROVIDER", "openai");
  const model = createAIProvider()("openai/gpt-4.1-mini");
  expect(model.provider).toBe("openai.chat");
  expect(model.modelId).toBe("gpt-4.1-mini");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "test-only-openrouter-key");
  expect(() => createAIProvider()).toThrow("Missing OPENAI_API_KEY");
});

test("unknown providers and foreign model overrides fail locally", () => {
  vi.stubEnv("AI_PROVIDER", "invalid");
  expect(() => getAIProvider()).toThrow("AI_PROVIDER must be");
  vi.stubEnv("AI_PROVIDER", "openai");
  for (const model of [
    "moonshotai/kimi-k2.6",
    "openai/gpt-oss-120b",
    "openai/",
    "openai/other/model",
  ]) {
    expect(() => getNativeOpenAIModelId(model)).toThrow(
      "native OpenAI model ID"
    );
  }
  vi.stubEnv("AI_VISION_MODEL", "moonshotai/kimi-k2.6");
  expect(() =>
    getConfiguredAIModel("AI_VISION_MODEL", "unused", "gpt-4.1")
  ).toThrow("native OpenAI model ID");
  expect(fetch).not.toHaveBeenCalled();
});

test("every core role and both agents load in native mode without OpenRouter", async () => {
  vi.stubEnv("AI_PROVIDER", "openai");
  const ai = await import("./ai");
  expect([ai.FAST_MODEL, ai.AUTOCOMPLETE_MODEL]).toEqual([
    "gpt-4.1-mini",
    "gpt-4.1-mini",
  ]);
  expect([
    ai.REASONING_MODEL,
    ai.ONBOARDING_MODEL,
    ai.PINNED_AGENT_MODEL,
    ai.OUTREACH_AGENT_MODEL,
    ai.PINNED_VISION_MODEL,
  ]).toEqual(Array(5).fill("gpt-4.1"));
  expect(ai.getRoutingTelemetry("fast").providerLabel).toBe("openai");
  expect(ai.supportsExplicitPromptCaching("openai/gpt-6-luna-pro")).toBe(false);
  const workspace = await import("../agents/index");
  const outreach = await import("../agents/outreach/index");
  expect(workspace.workspaceLanguageModel.provider).toBe("openai.chat");
  expect(workspace.workspaceMainLanguageModel.provider).toBe("openai.chat");
  expect(workspace.workspaceVisionLanguageModel.provider).toBe("openai.chat");
  expect(
    outreach.createOutreachThreadLanguageModel("test-thread").provider
  ).toBe("openai.chat");
  expect(outreach.outreachVisionLanguageModel.provider).toBe("openai.chat");
  expect(fetch).not.toHaveBeenCalled();
}, 15_000);

test("native structured generation sends only OpenAI requests and records tokens without invented cost", async () => {
  vi.stubEnv("AI_PROVIDER", "openai");
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response(
        JSON.stringify({
          id: "local-response",
          object: "chat.completion",
          created: 1,
          model: "gpt-4.1-mini",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: '{"ok":true}' },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        }),
        { headers: { "content-type": "application/json" } }
      );
    })
  );
  const { generateTextWithJsonParse } = await import("./ai");
  const result = await generateTextWithJsonParse({
    operation: "local routing check",
    schema: z.object({ ok: z.boolean() }),
    system: "Return JSON",
    prompt: "local fixture",
    nativeStructuredOutput: true,
  });
  expect(result.object).toEqual({ ok: true });
  expect(result.usage).toMatchObject({
    inputTokens: 12,
    outputTokens: 3,
    providerSelected: "openai",
  });
  expect(result.usage.cost).toBeUndefined();
  const { createOutreachThreadLanguageModel } =
    await import("../agents/outreach/index");
  await generateText({
    model: createOutreachThreadLanguageModel("local-thread"),
    prompt: "local fixture",
  });
  expect(requests).toHaveLength(2);
  for (const [index, request] of requests.entries()) {
    expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
    const body = await request.json();
    expect(body.model).toBe(index === 0 ? "gpt-4.1-mini" : "gpt-4.1");
    if (index === 0) expect(body.response_format.type).toBe("json_schema");
    for (const key of [
      "provider",
      "plugins",
      "session_id",
      "prompt_cache_options",
    ])
      expect(body).not.toHaveProperty(key);
  }
});

test("Jev diagnostics fail explicitly without any provider request in native mode", async () => {
  vi.stubEnv("AI_PROVIDER", "openai");
  vi.stubEnv("OPENROUTER_API_KEY", "test-only-openrouter-key");
  const { callJevDecisions } = await import("./jevClient");
  await expect(callJevDecisions({ state: {}, questions: {} })).rejects.toThrow(
    "Jev diagnostics are unavailable"
  );
  expect(fetch).not.toHaveBeenCalled();
});

test("native generation failures keep stronger-route retries on OpenAI even with an OpenRouter key", async () => {
  vi.stubEnv("AI_PROVIDER", "openai");
  vi.stubEnv("OPENROUTER_API_KEY", "test-only-openrouter-key");
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response(
        JSON.stringify({
          error: {
            message: "Local denied fixture",
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        }),
        { status: 401, headers: { "content-type": "application/json" } }
      );
    })
  );
  const { robustGenerateObject } = await import("./ai");
  await expect(
    robustGenerateObject({
      operation: "local failure routing check",
      schema: z.object({ ok: z.boolean() }),
      system: "Return JSON",
      prompt: "local fixture",
      routing: "fast",
      maxRetries: 1,
      failureLogLevel: "info",
    })
  ).rejects.toThrow("Local denied fixture");
  expect(requests).toHaveLength(2);
  expect(requests.map((request) => request.url)).toEqual(
    Array(2).fill("https://api.openai.com/v1/chat/completions")
  );
  expect(
    await Promise.all(
      requests.map(async (request) => (await request.json()).model)
    )
  ).toEqual(["gpt-4.1-mini", "gpt-4.1"]);
});

test("native webResearch advertises an object schema while retaining branch validation", async () => {
  vi.stubEnv("AI_PROVIDER", "openai");
  const { webResearch } = await import("../agents/tools/webResearch");
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const parameters = body.tools[0].function.parameters;
      requests.push(parameters);
      if (parameters.type !== "object" || parameters.anyOf) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "Invalid schema for function 'webResearch': schema must be a JSON Schema of type object",
              type: "invalid_request_error",
              code: "invalid_function_parameters",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          id: "local-tool-schema",
          object: "chat.completion",
          created: 1,
          model: "gpt-4.1",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Ready" },
              finish_reason: "stop",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } }
      );
    })
  );
  const result = await generateText({
    model: createAIProvider()("gpt-4.1"),
    prompt: "Local schema fixture",
    maxRetries: 0,
    tools: {
      webResearch: {
        description: webResearch.description,
        inputSchema: webResearch.inputSchema,
      },
    },
  });
  expect(result.text).toBe("Ready");
  expect(requests[0]).toMatchObject({
    type: "object",
    required: ["operation"],
    properties: {
      operation: expect.any(Object),
      query: expect.any(Object),
      url: expect.any(Object),
    },
  });
  const originalSchema = asSchema(webResearch.inputSchema);
  expect(await originalSchema.validate?.({ operation: "read" })).toMatchObject({
    success: false,
  });
  expect(
    await originalSchema.validate?.({
      operation: "read",
      url: "https://example.com",
    })
  ).toMatchObject({ success: true });
});
