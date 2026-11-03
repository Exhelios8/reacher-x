import {
  createOpenAI,
  type OpenAILanguageModelResponsesOptions,
} from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  wrapLanguageModel,
  defaultSettingsMiddleware,
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
  async transformParams({ model, params }) {
    return {
      ...params,
      tools: params.tools?.map((tool) =>
        tool.type === "function" &&
        (tool.inputSchema.anyOf || model.provider === "openai.responses")
          ? {
              ...tool,
              inputSchema: nativeToolSchema(tool.inputSchema),
              // Keep optional inputs optional; the SDK still validates the original schema.
              strict: tool.inputSchema.anyOf ? false : (tool.strict ?? false),
            }
          : tool
      ),
    };
  },
};

export function getAIProvider(): "openrouter" | "openai" | "hybrid" {
  const provider = process.env.AI_PROVIDER?.trim() || "openrouter";
  if (
    provider !== "openrouter" &&
    provider !== "openai" &&
    provider !== "hybrid"
  ) {
    throw new Error("AI_PROVIDER must be openrouter, openai or hybrid.");
  }
  return provider;
}

export function getAIModelProvider(model: string): "openrouter" | "openai" {
  const provider = getAIProvider();
  return provider === "hybrid"
    ? model.startsWith("openai/") || !model.includes("/")
      ? "openai"
      : "openrouter"
    : provider;
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
  const native = getAIProvider() !== "openrouter";
  const model = getConfiguredModel(
    key,
    native ? openAIDefault : openRouterDefault
  );
  return getAIModelProvider(model) === "openai"
    ? getNativeOpenAIModelId(model)
    : model;
}

export function createAIProvider() {
  const selectedProvider = getAIProvider();
  const openAIKey = process.env.OPENAI_API_KEY?.trim();
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (selectedProvider !== "openrouter" && !openAIKey) {
    throw new Error("[AI] Missing OPENAI_API_KEY environment variable.");
  }
  if (selectedProvider !== "openai" && !openRouterKey) {
    throw new Error(
      "[AI] Missing OPENROUTER_API_KEY environment variable. Get it from: https://openrouter.ai/settings/keys"
    );
  }
  const native = createOpenAI({ apiKey: openAIKey });
  const openRouter = createOpenRouter({
    apiKey: openRouterKey,
    headers: { "HTTP-Referer": "https://reacherx.com", "X-Title": "ReacherX" },
  });
  return (
    model: string,
    settings?: Parameters<typeof openRouter>[1],
    nativeOptions?: OpenAILanguageModelResponsesOptions
  ) => {
    if (getAIModelProvider(model) === "openrouter") {
      return openRouter(model, settings);
    }
    const modelId = getNativeOpenAIModelId(model);
    const responses = modelId.startsWith("gpt-6");
    // Native requests never inherit OpenRouter plugins, routing or cache settings.
    return wrapLanguageModel({
      model: responses ? native.responses(modelId) : native.chat(modelId),
      middleware: [
        nativeToolSchemaMiddleware,
        ...(responses
          ? [
              defaultSettingsMiddleware({
                settings: {
                  providerOptions: {
                    openai: { ...nativeOptions, store: false },
                  },
                },
              }),
            ]
          : []),
      ],
    });
  };
}
