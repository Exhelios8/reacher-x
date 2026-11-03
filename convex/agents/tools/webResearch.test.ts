// @vitest-environment node
import { asSchema } from "ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createBlogCardArtifact,
  createBlogDemoArtifact,
  validateAgentArtifactEnvelope,
} from "../../../shared/lib/json-render/agentArtifacts";
import { getAgentArtifactsFromToolResult } from "../../../features/agent/lib/toolArtifacts";
import { searchReacherXBlog, searchWeb } from "../../lib/researchCore";
import { getWebResearchModelOutput, webResearch } from "./webResearch";

vi.mock("../../lib/researchCore", () => ({
  readWebPages: vi.fn(),
  searchReacherXBlog: vi.fn(),
  searchWeb: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

describe("web research domain filters", () => {
  test("forwards validated domain filters to web search", async () => {
    const input = {
      operation: "search",
      query: "SEO agency recommendations",
      scope: "web",
      limit: 2,
      includeDomains: [
        "reddit.com",
        "threads.com",
        "threads.net",
        "linkedin.com",
        "www.linkedin.com",
      ],
    };
    const validated = await asSchema(webResearch.inputSchema).validate?.(input);
    if (!validated?.success) throw new Error("Expected valid search input");
    vi.mocked(searchWeb).mockResolvedValue([]);
    const tool = { ...webResearch, ctx: {} };

    await tool.execute!(validated.value, {
      toolCallId: "search",
      messages: [],
    });

    expect(searchWeb).toHaveBeenCalledExactlyOnceWith(
      input.query,
      expect.objectContaining({ consumer: "agents.webResearch" }),
      {
        maxResults: 2,
        maxCharacters: 1200,
        includeDomains: input.includeDomains,
      }
    );
  });

  test("keeps ReacherX blog scope independent of caller domain filters", async () => {
    const validated = await asSchema(webResearch.inputSchema).validate?.({
      operation: "search",
      query: "getting replies",
      scope: "reacherx",
      includeDomains: ["reddit.com"],
    });
    if (!validated?.success) throw new Error("Expected valid search input");
    vi.mocked(searchReacherXBlog).mockResolvedValue([]);
    const tool = { ...webResearch, ctx: {} };

    await tool.execute!(validated.value, { toolCallId: "blog", messages: [] });

    expect(searchReacherXBlog).toHaveBeenCalledExactlyOnceWith(
      "getting replies",
      expect.any(Object),
      { maxResults: 3, maxCharacters: 1200 }
    );
    expect(searchWeb).not.toHaveBeenCalled();
  });

  test.each(
    [
      ["https://reddit.com"],
      ["reddit.com/r/seo"],
      ["reddit.com:443"],
      ["reddit..com"],
      ["-reddit.com"],
      ["*.reddit.com"],
      [],
      Array.from({ length: 6 }, () => "reddit.com"),
    ].map((includeDomains) => ({ includeDomains }))
  )(
    "rejects invalid domain filters $includeDomains",
    async ({ includeDomains }) => {
      expect(
        await asSchema(webResearch.inputSchema).validate?.({
          operation: "search",
          query: "SEO recommendations",
          includeDomains,
        })
      ).toMatchObject({ success: false });
    }
  );
});

describe("web research model output", () => {
  test("persists a metadata-only artifact for the inline UI", () => {
    const artifact = createBlogCardArtifact({
      slug: "reach-out-and-get-replies",
      title: "How to reach out and actually get replies",
      sourceUrl: "https://reacherx.com/blog/reach-out-and-get-replies",
    });

    expect(artifact).toBeDefined();
    expect(validateAgentArtifactEnvelope(artifact)).toEqual(artifact);

    const output = getWebResearchModelOutput({
      success: true,
      operation: "show",
      artifact,
    });

    expect(output.type).toBe("json");
    expect(getAgentArtifactsFromToolResult(output.value)).toEqual([artifact]);
    expect(JSON.stringify(output.value)).not.toMatch(/<iframe|<svg|<html/i);
  });

  test("reconstructs show artifacts for older saved tool results", () => {
    const articleArtifact = createBlogCardArtifact({
      slug: "reach-out-and-get-replies",
      sourceUrl: "https://www.reacherx.com/blog/reach-out-and-get-replies",
    });
    const demoArtifact = createBlogDemoArtifact({
      scenario: "reach-out-writing-preferences",
      title: "Interactive walkthrough",
      caption: "Explore this workflow in ReacherX.",
      sourceUrl: "https://www.reacherx.com",
    });

    expect(
      getAgentArtifactsFromToolResult(
        JSON.stringify({ success: true, operation: "show" }),
        {
          operation: "show",
          resourceType: "article",
          slug: "reach-out-and-get-replies",
          sourceUrl: "https://www.reacherx.com/blog/reach-out-and-get-replies",
        }
      )
    ).toEqual([articleArtifact]);
    expect(
      getAgentArtifactsFromToolResult(
        JSON.stringify({ success: true, operation: "show" }),
        {
          operation: "show",
          resourceType: "article",
          slug: "Guide",
          sourceUrl: "https://reacherx.com/blog/Guide",
        }
      )
    ).toEqual([
      createBlogCardArtifact({
        slug: "guide",
        sourceUrl: "https://reacherx.com/blog/Guide",
      }),
    ]);
    expect(
      getAgentArtifactsFromToolResult(
        JSON.stringify({ success: true, operation: "show" }),
        {
          operation: "show",
          resourceType: "demo",
          demoId: "reach-out-writing-preferences",
          sourceUrl: "https://www.reacherx.com",
        }
      )
    ).toEqual([demoArtifact]);
  });
});
