import { afterEach, beforeEach, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.stubEnv("AI_PROVIDER", "openai");
  vi.stubEnv("OPENAI_API_KEY", "test-only-openai-key");
  vi.stubEnv("AI_REASONING_MODEL", "gpt-6-luna");
  vi.stubEnv("AI_ONBOARDING_MODEL", "gpt-6-luna");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

test("compliance leaves room for reasoning before returning a validated violation", async () => {
  const verdict = {
    compliant: false,
    violations: ["The candidate is outside the instructed geography."],
    repairInstruction: "Use only evidence of a company operating in France.",
  };
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      // Reproduce a reasoning-only response when the shared output budget runs out.
      const complete = body.max_output_tokens >= 4_224;
      return new Response(
        JSON.stringify({
          id: "resp_compliance",
          created_at: 1,
          model: "gpt-6-luna",
          status: complete ? "completed" : "incomplete",
          incomplete_details: complete ? null : { reason: "max_output_tokens" },
          output: complete
            ? [
                {
                  type: "message",
                  id: "msg_compliance",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: JSON.stringify(verdict),
                      annotations: [],
                    },
                  ],
                },
              ]
            : [],
          usage: {
            input_tokens: 300,
            output_tokens: complete ? 4_224 : body.max_output_tokens,
            output_tokens_details: {
              reasoning_tokens: complete ? 4_096 : body.max_output_tokens,
            },
          },
        }),
        { headers: { "content-type": "application/json" } }
      );
    })
  );
  const { evaluateWorkspaceMemoryCompliance } =
    await import("./workspaceMemoryCompliance");
  await expect(
    evaluateWorkspaceMemoryCompliance({
      instructions: ["The company must operate in France."],
      taskContext: "Qualify the supplied company.",
      candidate: "The company operates only in Canada.",
    })
  ).resolves.toEqual(verdict);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    reasoning: { mode: "pro", effort: "medium" },
    text: { format: { type: "json_schema" } },
  });
});
