import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { callJevDecisions, JevClientError } from "./jevClient";

const request = {
  state: { profile: "fixture" },
  questions: {
    q1: { type: "choice", instructions: "x", criteria: {} },
  },
} as const;

const validPayload = {
  id: "resp-1",
  model: "typesafe/jev-1.13",
  provider: "typesafe",
  answers: {
    q1: { type: "choice", choice: "matched", confidence: 0.9 },
  },
  usage: { cost: 0.01, input_tokens: 100, output_tokens: 10 },
};

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubEnv("AI_PROVIDER", "openrouter");
  vi.stubEnv("OPENROUTER_API_KEY", "test-only-openrouter-key");
  vi.stubEnv("OPENAI_API_KEY", "test-only-openai-key");
  vi.stubEnv("AI_JEV_MODEL", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("callJevDecisions provider routing", () => {
  test.each(["openrouter", "hybrid"])(
    "%s uses the Decisions endpoint and OpenRouter credentials",
    async (provider) => {
      vi.stubEnv("AI_PROVIDER", provider);
      vi.stubEnv("AI_JEV_MODEL", "typesafe/jev-configured");
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse(validPayload));
      vi.stubGlobal("fetch", fetchMock);

      const result = await callJevDecisions({
        ...request,
        sessionId: "jev-fixture",
      });

      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        "https://openrouter.ai/api/alpha/decisions",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "Bearer test-only-openrouter-key",
            "Content-Type": "application/json",
          },
        })
      );
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
        model: "typesafe/jev-configured",
        state: request.state,
        questions: request.questions,
        session_id: "jev-fixture",
      });
      expect(result.response.usage).toEqual({
        cost: 0.01,
        inputTokens: 100,
        outputTokens: 10,
      });
      expect(result.attempts).toBe(1);
    }
  );

  test.each(["openrouter", "hybrid"])(
    "%s without an OpenRouter key fails before any request",
    async (provider) => {
      vi.stubEnv("AI_PROVIDER", provider);
      vi.stubEnv("OPENROUTER_API_KEY", "   ");
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);

      await expect(callJevDecisions(request)).rejects.toThrow(
        "Missing OPENROUTER_API_KEY"
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  test("OpenAI-only mode stays blocked even with an OpenRouter key", async () => {
    vi.stubEnv("AI_PROVIDER", "openai");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(callJevDecisions(request)).rejects.toThrow(
      "Jev diagnostics are unavailable with AI_PROVIDER=openai"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an invalid provider fails closed before any request", async () => {
    vi.stubEnv("AI_PROVIDER", "invalid");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(callJevDecisions(request)).rejects.toThrow(
      "AI_PROVIDER must be"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("hybrid payment failures do not retry or fall back to OpenAI", async () => {
    vi.stubEnv("AI_PROVIDER", "hybrid");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "Insufficient credits" } }),
        {
          status: 402,
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(callJevDecisions(request)).rejects.toThrow(
      "Jev decisions request failed (status 402): Insufficient credits"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://openrouter.ai/api/alpha/decisions"
    );
  });
});

describe("callJevDecisions transport retries", () => {
  test("retries when a 2xx body read fails mid-stream", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new TypeError("terminated");
        },
      })
      .mockResolvedValueOnce(jsonResponse(validPayload));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callJevDecisions({
      state: {},
      questions: { q1: { type: "choice", instructions: "x", criteria: {} } },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    expect(result.response.answers.q1).toMatchObject({ choice: "matched" });
  });

  test("does not retry a 2xx response with a malformed JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callJevDecisions({
        state: {},
        questions: { q1: { type: "choice", instructions: "x", criteria: {} } },
      })
    ).rejects.toThrow(JevClientError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("hybrid mode accumulates billed usage when retrying degenerate answers", async () => {
    vi.stubEnv("AI_PROVIDER", "hybrid");
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          ...validPayload,
          answers: {
            q1: { type: "choice", choice: "matched", confidence: 0.01 },
          },
          usage: { cost: 0.02, input_tokens: 200, output_tokens: 20 },
        })
      )
      .mockResolvedValueOnce(jsonResponse(validPayload));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callJevDecisions(request);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    expect(result.response.answers.q1).toMatchObject({
      choice: "matched",
      confidence: 0.9,
    });
    expect(result.response.usage).toEqual({
      cost: 0.03,
      inputTokens: 300,
      outputTokens: 30,
    });
    for (const [endpoint, init] of fetchMock.mock.calls) {
      expect(endpoint).toBe("https://openrouter.ai/api/alpha/decisions");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer test-only-openrouter-key",
      });
    }
  });
});
