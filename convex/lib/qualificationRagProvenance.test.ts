import { beforeEach, expect, test, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import {
  indexEvidencePosts,
  projectQualificationEvidenceForRag,
} from "./ragIndexing";
import type { QualificationSource } from "./qualificationEvidenceCore";
import { convertToEvidencePosts } from "./enrichmentCore";
const { add } = vi.hoisted(() => ({ add: vi.fn().mockResolvedValue({}) }));
vi.mock("../agents/outreach/rag", () => ({
  getProspectRag: () => ({ add }),
  getAgentMemoryRag: () => ({ add }),
  getProspectNamespace: (id: string) => `prospect:${id}`,
  getWorkspaceNamespace: (id: string) => `workspace:${id}`,
}));

beforeEach(() => vi.clearAllMocks());

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

test("RAG retains independent observation, source and checked destination without social attribution", async () => {
  const posts = convertToEvidencePosts(
    [
      {
        id: "site_problem:42:hash",
        evidenceKind: "observed_site_problem",
        employerName: "Courses",
        url: "https://courses.example/catalogue",
        targetUrl: "https://courses.example/missing",
        httpStatus: 410,
        observedAt: "2026-11-05T09:00:00Z",
        publishedAt: "2020-01-01",
        text: "Observed HTTP 410, confirmed by two GET requests.",
      },
    ],
    "linkedin"
  );
  expect(posts[0]).toMatchObject({
    evidenceKind: "observed_site_problem",
    observedAt: "2026-11-05T09:00:00Z",
    targetUrl: "https://courses.example/missing",
    httpStatus: 410,
  });
  expect(posts[0].publishedAt).toBeUndefined();
  const source: QualificationSource = {
    sourceId: "site_problem:42:hash",
    platform: "linkedin",
    contentType: "observed_site_problem",
    evidenceKind: "observed_site_problem",
    authorId: "observer:reacherx",
    employerName: "Courses",
    sourceUrl: "https://courses.example/catalogue",
    evidenceUrl: "https://courses.example/missing",
    text: posts[0].text,
    supportingQuote: posts[0].text,
    observedAt: "2026-11-05T09:00:00Z",
    httpStatus: 410,
    publishedAt: "2020-01-01",
    verifiedAt: Date.parse("2026-11-05T10:00:00Z"),
    verificationVersion: 1,
    discoveryQueries: [],
    sourcePost: {},
  };
  const projected = projectQualificationEvidenceForRag([source], "linkedin");
  expect(projected[0]).toMatchObject({
    url: source.sourceUrl,
    targetUrl: source.evidenceUrl,
    observedAt: source.observedAt,
    httpStatus: 410,
    verifiedAt: source.verifiedAt,
  });
  expect(projected[0].publishedAt).toBeUndefined();
  expect(
    projectQualificationEvidenceForRag(
      [
        {
          ...source,
          evidenceKind: "employer_event",
          contentType: "employer_event",
        },
      ],
      "linkedin"
    )
  ).toEqual([
    {
      id: source.sourceId,
      text: source.text,
      url: source.evidenceUrl,
      platform: "linkedin",
      evidenceKind: "employer_event",
      employerName: "Courses",
      publishedAt: "2020-01-01",
    },
  ]);
  await indexEvidencePosts({} as ActionCtx, "prospect", projected);
  expect(add.mock.calls[0][1]).toMatchObject({
    text: expect.stringContaining(
      "Independent website observation by ReacherX"
    ),
    metadata: {
      source: "https://courses.example/catalogue",
      type: "observed_site_problem",
    },
    filterValues: [{ name: "contentType", value: "observed_site_problem" }],
  });
  const text = add.mock.calls[0][1].text;
  expect(text).toContain("Observed: 2026-11-05T09:00:00Z");
  expect(text).toContain("Verified at: 2026-11-05T10:00:00.000Z");
  expect(text).toContain("Linked destination: https://courses.example/missing");
  expect(text).toContain("Confirmed HTTP: 410 (two GET requests)");
  expect(text).toContain("no role, buying intent, budget or financial fact");
  expect(text).toContain("No social reply or action");
  expect(text).not.toContain("Published:");
});
