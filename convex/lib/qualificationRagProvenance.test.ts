import { expect, test, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import { indexEvidencePosts } from "./ragIndexing";
const { add } = vi.hoisted(() => ({ add: vi.fn().mockResolvedValue({}) }));
vi.mock("../agents/outreach/rag", () => ({
  getProspectRag: () => ({ add }),
  getAgentMemoryRag: () => ({ add }),
  getProspectNamespace: (id: string) => `prospect:${id}`,
  getWorkspaceNamespace: (id: string) => `workspace:${id}`,
}));

test("RAG preserves corporate attribution, source URL and publication separately from personal posts", async () => {
  await indexEvidencePosts({} as ActionCtx, "prospect", [
    {
      id: "employer:42:hash",
      platform: "linkedin",
      evidenceKind: "employer_event",
      employerName: "Courses",
      publishedAt: "2026-11-04",
      url: "https://courses.example/news",
      text: "Courses is migrating its catalogue.",
    },
    { id: "post", platform: "linkedin", text: "I teach online." },
  ]);
  expect(add).toHaveBeenCalledTimes(2);
  expect(add.mock.calls[0][1]).toMatchObject({
    namespace: "prospect:prospect",
    text: expect.stringContaining("Official employer event: Courses."),
    metadata: {
      source: "https://courses.example/news",
      type: "employer_event",
    },
    filterValues: [{ name: "contentType", value: "employer_event" }],
  });
  expect(add.mock.calls[0][1].text).toContain("not a personal post");
  expect(add.mock.calls[0][1].text).toContain(
    "Source: https://courses.example/news"
  );
  expect(add.mock.calls[0][1].text).toContain("Published: 2026-11-04");
  expect(add.mock.calls[1][1]).toMatchObject({
    text: "I teach online.",
    filterValues: [{ name: "contentType", value: "evidence_post" }],
  });
});
