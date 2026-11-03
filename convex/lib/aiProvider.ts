import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  wrapLanguageModel,
  type JSONSchema7,
  type LanguageModelMiddleware,
} from "ai";
import {
  getConfiguredModel,
  type ModelEnvironmentKey,
} from "./modelConfigHelpers";

function nativeToolSchema(schema: JSONSchema7): JSONSchema7 {
  if (!schema.anyOf) return schema;
  const branches = schema.anyOf.filter(
    (branch): branch is JSONSchema7 =>
      typeof branch === "object" && branch !== null && branch.type === "object"
  );
  if (!branches.length || branches.length !== schema.anyOf.length) {
    throw new Error(
      "Native OpenAI tools require an object or a union of objects."
    );
  }
  const properties: NonNullable<JSONSchema7["properties"]> = {};
  for (const branch of branches) {
    for (const [key, definition] of Object.entries(branch.properties ?? {})) {
      const existing = properties[key];
      properties[key] =
        existing === undefined ||
        JSON.stringify(existing) === JSON.stringify(definition)
          ? definition
          : { anyOf: [existing, definition] };
    }
  }
  const { anyOf: _anyOf, ...root } = schema;
  // OpenAI forbids root unions; the SDK still validates calls against the original Zod schema.
  return {
    ...root,
    type: "object",
    properties,
    required: (branches[0].required ?? []).filter((key) =>
      branches.every((branch) => branch.required?.includes(key))
    ),
    additionalProperties: false,
  };
}

const nativeToolSchemaMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v3",
  async transformParams({ params }) {
    return {
      ...params,
      tools: params.tools?.map((tool) =>
        tool.type === "function" && tool.inputSchema.anyOf
          ? {
              ...tool,
              inputSchema: nativeToolSchema(tool.inputSchema),
              strict: false,
            }
          : tool
      ),
    };
  },
};

export function getAIProvider(): "openrouter" | "openai" {
  const provider = process.env.AI_PROVIDER?.trim() || "openrouter";
  if (provider !== "openrouter" && provider !== "openai") {
    throw new Error("AI_PROVIDER must be openrouter or openai.");
  }
  return provider;
}

export function getNativeOpenAIModelId(model: string): string {
  const modelId = model.startsWith("openai/") ? model.slice(7) : model;
  if (
    !modelId ||
    !/^[a-zA-Z0-9._:-]+$/.test(modelId) ||
    modelId.startsWith("gpt-oss")
  ) {
    throw new Error(
      `AI_PROVIDER=openai requires a native OpenAI model ID; received ${model}.`
    );
  }
  return modelId;
}

export function getConfiguredAIModel(
  key: ModelEnvironmentKey,
  openRouterDefault: string,
  openAIDefault: string
): string {
  const native = getAIProvider() === "openai";
  const model = getConfiguredModel(
    key,
    native ? openAIDefault : openRouterDefault
  );
  return native ? getNativeOpenAIModelId(model) : model;
}

export function createAIProvider() {
  if (getAIProvider() === "openai") {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey)
      throw new Error("[AI] Missing OPENAI_API_KEY environment variable.");
    const provider = createOpenAI({ apiKey });
    // Native requests must not inherit OpenRouter plugins, routing or cache settings.
    return (
      model: string,
      _settings?: Parameters<ReturnType<typeof createOpenRouter>>[1]
    ) =>
      wrapLanguageModel({
        model: provider.chat(getNativeOpenAIModelId(model)),
        middleware: nativeToolSchemaMiddleware,
      });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "[AI] Missing OPENROUTER_API_KEY environment variable. Get it from: https://openrouter.ai/settings/keys"
    );
  }
  const provider = createOpenRouter({
    apiKey,
    headers: { "HTTP-Referer": "https://reacherx.com", "X-Title": "ReacherX" },
  });
  return (model: string, settings?: Parameters<typeof provider>[1]) =>
    provider(model, settings);
}
