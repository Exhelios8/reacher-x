import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { generateText, stepCountIs, streamText } from "ai";
import { z } from "zod";
import { MODEL_ENVIRONMENT_KEYS } from "./modelConfigHelpers";
import {
  createAIProvider,
  getAIModelProvider,
  getConfiguredAIModel,
} from "./aiProvider";

function responseFixture(text = "Ready") {
  return {
    id: "resp_local",
    created_at: 1,
    model: "gpt-6-luna",
    output: [
      {
        type: "message",
        id: "msg_local",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 12,
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

beforeEach(() => {
  vi.stubEnv("AI_PROVIDER", "hybrid");
  vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  for (const key of MODEL_ENVIRONMENT_KEYS) vi.stubEnv(key, "");
  for (const key of [
    "AI_FAST_MODEL",
    "AI_REASONING_MODEL",
    "AI_AUTOCOMPLETE_MODEL",
    "AI_ONBOARDING_MODEL",
    "AI_SETUP_AGENT_MODEL",
    "AI_MAIN_AGENT_MODEL",
  ])
    vi.stubEnv(key, "gpt-6-luna");
  vi.stubEnv("AI_VISION_MODEL", "moonshotai/kimi-k2.6");
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

test("hybrid separates model providers and requires both credentials", () => {
  expect(getAIModelProvider("gpt-6-luna")).toBe("openai");
  expect(getAIModelProvider("openai/gpt-6-luna")).toBe("openai");
  expect(getAIModelProvider("moonshotai/kimi-k2.6")).toBe("openrouter");
  expect(getConfiguredAIModel("AI_VISION_MODEL", "unused", "gpt-4.1")).toBe(
    "moonshotai/kimi-k2.6"
  );
  vi.stubEnv("AI_VISION_MODEL", "openai/gpt-4.1");
  expect(getConfiguredAIModel("AI_VISION_MODEL", "unused", "gpt-4.1")).toBe(
    "gpt-4.1"
  );
  vi.stubEnv("OPENROUTER_API_KEY", "");
  expect(() => createAIProvider()).toThrow("Missing OPENROUTER_API_KEY");
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  vi.stubEnv("OPENAI_API_KEY", "");
  expect(() => createAIProvider()).toThrow("Missing OPENAI_API_KEY");
  expect(fetch).not.toHaveBeenCalled();
});

test("one Luna ID selects Standard helpers and Pro judgment roles while Kimi uses OpenRouter", async () => {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return new Response(
        JSON.stringify(
          request.url.includes("api.openai.com")
            ? responseFixture('{"ok":true}')
            : {
                id: "or_local",
                object: "chat.completion",
                created: 1,
                model: "moonshotai/kimi-k2.6",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "Visible" },
                    finish_reason: "stop",
                  },
                ],
              }
        ),
        { headers: { "content-type": "application/json" } }
      );
    })
  );
  const ai = await import("./ai");
  for (const routing of ["fast", "reasoning", "onboarding"] as const)
    await ai.generateTextWithJsonParse({
      operation: "fixture",
      schema: z.object({ ok: z.boolean() }),
      system: "Return JSON",
      prompt: "Fixture",
      routing,
      nativeStructuredOutput: true,
    });
  const agents = await import("../agents/index");
  const outreach = await import("../agents/outreach/index");
  for (const model of [
    agents.workspaceLanguageModel,
    agents.workspaceMainLanguageModel,
    outreach.createOutreachThreadLanguageModel("local"),
    agents.workspaceVisionLanguageModel,
    outreach.outreachVisionLanguageModel,
  ])
    await generateText({ model, prompt: "Fixture", maxRetries: 0 });
  expect(requests).toHaveLength(8);
  for (const [index, request] of requests.entries()) {
    const body = await request.json();
    if (index < 6) {
      expect(request.url).toBe("https://api.openai.com/v1/responses");
      expect(request.headers.get("authorization")).toBe(
        "Bearer test-openai-key"
      );
      expect(body).toMatchObject({
        model: "gpt-6-luna",
        store: false,
        reasoning: {
          mode: index === 0 ? "standard" : "pro",
          effort: index === 0 ? "none" : "medium",
        },
      });
      if (index < 3) expect(body.text.format.type).toBe("json_schema");
      if (index === 5) expect(body.max_output_tokens).toBe(4096);
      for (const key of [
        "provider",
        "plugins",
        "session_id",
        "prompt_cache_options",
        "forceReasoning",
        "temperature",
      ])
        expect(body).not.toHaveProperty(key);
    } else {
      expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(request.headers.get("authorization")).toBe(
        "Bearer test-openrouter-key"
      );
      expect(body.model).toBe("moonshotai/kimi-k2.6");
      if (index === 7) expect(body.max_tokens).toBe(1024);
      expect(body).not.toHaveProperty("reasoning");
      expect(body).not.toHaveProperty("store");
    }
  }
  expect(ai.getRoutingTelemetry("fast").providerLabel).toBe("openai");
  expect(ai.supportsExplicitPromptCaching("gpt-6-luna")).toBe(false);
  expect(outreach.outreachAgent.options.callSettings).not.toHaveProperty(
    "maxOutputTokens"
  );
}, 15_000);

test.each(["fast", "reasoning"] as const)(
  "failed %s generation never switches provider",
  async (routing) => {
    vi.stubEnv("AI_REASONING_MODEL", "moonshotai/kimi-k2.6");
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
        operation: "fixture",
        schema: z.object({ ok: z.boolean() }),
        system: "JSON",
        prompt: "Fixture",
        routing,
        fallbackRouting: "onboarding",
        maxRetries: 1,
        failureLogLevel: "info",
      })
    ).rejects.toThrow("Local denied fixture");
    expect(requests.map((r) => r.url)).toEqual([
      routing === "fast"
        ? "https://api.openai.com/v1/responses"
        : "https://openrouter.ai/api/v1/chat/completions",
    ]);
  }
);

test("Pro tool turns replay encrypted reasoning and results and preserve optional inputs", async () => {
  const { webResearch } = await import("../agents/tools/webResearch");
  const { createOutreachThreadLanguageModel } =
    await import("../agents/outreach/index");
  const requests: Request[] = [];
  const execute = vi.fn(async () => ({ success: true }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      const fixture = responseFixture("Verified");
      return new Response(
        JSON.stringify(
          requests.length === 1
            ? {
                ...fixture,
                output: [
                  {
                    type: "reasoning",
                    id: "rs_local",
                    summary: [],
                    encrypted_content: "local-encrypted-reasoning",
                  },
                  {
                    type: "function_call",
                    id: "fc_local",
                    call_id: "call_local",
                    name: "webResearch",
                    arguments:
                      '{"operation":"read","url":"https://example.com"}',
                  },
                ],
              }
            : fixture
        ),
        { headers: { "content-type": "application/json" } }
      );
    })
  );
  const result = await generateText({
    model: createOutreachThreadLanguageModel("local-tools"),
    system: "Use research once",
    prompt: "Fixture",
    maxOutputTokens: 4096,
    maxRetries: 0,
    stopWhen: stepCountIs(2),
    tools: {
      webResearch: {
        description: webResearch.description,
        inputSchema: webResearch.inputSchema,
        execute,
      },
      optionalInput: {
        inputSchema: z.object({
          query: z.string(),
          limit: z.number().optional(),
        }),
      },
    },
  });
  expect(result.text).toBe("Verified");
  expect(execute).toHaveBeenCalledExactlyOnceWith(
    { operation: "read", url: "https://example.com" },
    expect.any(Object)
  );
  expect(requests).toHaveLength(2);
  const [first, second] = await Promise.all(requests.map((r) => r.json()));
  expect(first).toMatchObject({
    model: "gpt-6-luna",
    store: false,
    max_output_tokens: 4096,
    reasoning: { mode: "pro", effort: "medium" },
    include: ["reasoning.encrypted_content"],
  });
  expect(first.tools[0]).toMatchObject({
    type: "function",
    name: "webResearch",
    strict: false,
    parameters: { type: "object", required: ["operation"] },
  });
  expect(first.tools[1]).toMatchObject({
    strict: false,
    parameters: { required: ["query"] },
  });
  expect(second.input).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "reasoning",
        encrypted_content: "local-encrypted-reasoning",
      }),
      expect.objectContaining({ type: "function_call", call_id: "call_local" }),
      expect.objectContaining({
        type: "function_call_output",
        call_id: "call_local",
        output: '{"success":true}',
      }),
    ])
  );
  expect(
    second.input.some(
      (item: { type: string }) => item.type === "item_reference"
    )
  ).toBe(false);
});

test("Pro streaming passes through current outreach middleware using Responses events", async () => {
  const { createOutreachThreadLanguageModel } =
    await import("../agents/outreach/index");
  const fixture = responseFixture();
  const chunks = [
    { type: "response.created", response: fixture },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_local" },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_local",
      delta: "Ready",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: fixture.output[0],
    },
    { type: "response.completed", response: fixture },
  ];
  let body: Record<string, unknown> | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } }
      );
    })
  );
  const result = streamText({
    model: createOutreachThreadLanguageModel("local-stream"),
    prompt: "Fixture",
    maxRetries: 0,
  });
  const text: string[] = [];
  for await (const delta of result.textStream) text.push(delta);
  expect(text.join("")).toBe("Ready");
  expect(await result.finishReason).toBe("stop");
  expect(await result.usage).toMatchObject({
    inputTokens: 12,
    outputTokens: 3,
  });
  expect(body).toMatchObject({
    stream: true,
    store: false,
    reasoning: { mode: "pro", effort: "medium" },
  });
});
