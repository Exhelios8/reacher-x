import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import {
  collectQualificationDiscoveryEvidence,
  getQualificationProfileText,
} from "./qualificationDiscoveryEvidenceCore";
import { prepareQualificationCandidates } from "./qualificationEvidenceCore";
import { readWebPages } from "./researchCore";

vi.mock("./researchCore", () => ({ readWebPages: vi.fn() }));
beforeEach(() => vi.mocked(readWebPages).mockReset().mockResolvedValue([]));

const prospect = {
  _id: "prospect",
  workspaceId: "workspace",
  platform: "linkedin",
  discoverySource: "search_people",
  qualificationStatus: "pending",
  linkedinUsername: "educator",
  linkedinUserUrn: "ACo123",
  data: { username: "educator", urn: "ACo123" },
  evidencePosts: [],
} as unknown as Doc<"prospects">;
const profile = {
  id: 123,
  urn: "ACo123",
  username: "educator",
  headline: "Course creator",
  summary: "I teach software workflows.",
  position: [
    {
      title: "Instructor",
      companyName: "Courses",
      description: "I record step-by-step software tutorials.",
    },
  ],
};
function context() {
  const runQuery = vi
    .fn()
    .mockResolvedValue({ description: "Find educators", icps: [] });
  const runAction = vi
    .fn()
    .mockResolvedValueOnce({ success: true, profile })
    .mockResolvedValueOnce({ posts: [] });
  const runMutation = vi.fn().mockResolvedValue(null);
  return {
    ctx: { runQuery, runAction, runMutation } as unknown as ActionCtx,
    runAction,
    runMutation,
  };
}
describe("people-search qualification evidence acquisition", () => {
  test("social-search results acquire the verified profile without replacing their authored posts", async () => {
    const mock = context();
    const post = {
      id: "request",
      text: "I need SEO help",
      author: { urn: "ACo123" },
    };
    const result = await collectQualificationDiscoveryEvidence(mock.ctx, {
      ...prospect,
      discoverySource: "search_post",
      evidencePosts: [post],
    });
    expect(result?.evidencePosts).toEqual([post]);
    expect(result?.profileData.urn).toBe("ACo123");
    expect(mock.runAction).toHaveBeenCalledOnce();
  });
  test("a successful empty activity lookup still retains real responsibilities and a profile source", async () => {
    const mock = context();
    const result = await collectQualificationDiscoveryEvidence(
      mock.ctx,
      prospect
    );
    expect(result?.evidencePosts).toEqual([]);
    expect(getQualificationProfileText(result!.profileData)).toContain(
      "I record step-by-step software tutorials."
    );
    expect(result?.profileData.url).toBe(
      "https://www.linkedin.com/in/educator"
    );
    expect(mock.runMutation).toHaveBeenCalledOnce();
    expect(mock.runAction.mock.calls[1][1]).toEqual({
      urn: "ACo123",
      maxPosts: 10,
    });
  });
  test("normalizes fetched activity into verifiable stable source identities", async () => {
    const mock = context();
    mock.runAction
      .mockReset()
      .mockResolvedValueOnce({ success: true, profile })
      .mockResolvedValueOnce({
        posts: [
          {
            urn: "urn:li:activity:7501008973442039808",
            text: "I record software tutorials",
            author: { urn: "ACo123" },
          },
        ],
      });
    const result = await collectQualificationDiscoveryEvidence(
      mock.ctx,
      prospect
    );
    const candidates = prepareQualificationCandidates({
      platform: "linkedin",
      profileData: result!.profileData,
      evidencePosts: result!.evidencePosts,
      discoveryQueries: [],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceId).toBe("urn:li:activity:7501008973442039808");
  });
  test.each(["profile", "activity"])(
    "%s provider failure throws without caching a false negative",
    async (stage) => {
      const mock = context();
      mock.runAction.mockReset();
      if (stage === "activity")
        mock.runAction.mockResolvedValueOnce({ success: true, profile });
      mock.runAction.mockRejectedValueOnce(new Error("Provider rate limited"));
      await expect(
        collectQualificationDiscoveryEvidence(mock.ctx, prospect)
      ).rejects.toThrow("rate limited");
      expect(mock.runMutation).not.toHaveBeenCalled();
    }
  );
  test("profile provider's soft failure also retries", async () => {
    const mock = context();
    mock.runAction
      .mockReset()
      .mockResolvedValueOnce({ success: false, error: "503 unavailable" });
    await expect(
      collectQualificationDiscoveryEvidence(mock.ctx, prospect)
    ).rejects.toThrow("503 unavailable");
    expect(mock.runMutation).not.toHaveBeenCalled();
  });
  test("rejects evidence returned for a different person", async () => {
    const mock = context();
    mock.runAction.mockReset().mockResolvedValueOnce({
      success: true,
      profile: { ...profile, id: 999, urn: "other", username: "other" },
    });
    await expect(
      collectQualificationDiscoveryEvidence(mock.ctx, prospect)
    ).rejects.toThrow("different profile");
    expect(mock.runMutation).not.toHaveBeenCalled();
  });
  test("retry uses the successfully cached evidence without more external requests", async () => {
    const mock = context();
    const result = await collectQualificationDiscoveryEvidence(mock.ctx, {
      ...prospect,
      qualificationProfileData: { ...profile, qualificationContextVersion: 2 },
      qualificationEvidenceFetchedAt: 1,
    });
    expect(result?.profileData).toEqual({
      ...profile,
      qualificationContextVersion: 2,
    });
    expect(mock.runAction).not.toHaveBeenCalled();
  });
  test("a matching username cannot override a conflicting stable profile identity", async () => {
    const mock = context();
    mock.runAction.mockReset().mockResolvedValueOnce({
      success: true,
      profile: { ...profile, id: 999, urn: "ACoOther" },
    });
    await expect(
      collectQualificationDiscoveryEvidence(mock.ctx, prospect)
    ).rejects.toThrow("different profile");
    expect(mock.runAction).toHaveBeenCalledOnce();
    expect(mock.runMutation).not.toHaveBeenCalled();
  });
  test("a matching stable identity allows a renamed username", async () => {
    const mock = context();
    mock.runAction
      .mockReset()
      .mockResolvedValueOnce({
        success: true,
        profile: { ...profile, username: "renamed-educator" },
      })
      .mockResolvedValueOnce({ posts: [] });
    const result = await collectQualificationDiscoveryEvidence(
      mock.ctx,
      prospect
    );
    expect(result?.profileData.url).toBe(
      "https://www.linkedin.com/in/renamed-educator"
    );
    expect(mock.runMutation).toHaveBeenCalledOnce();
  });
  test("username-only seeds can still acquire verified evidence", async () => {
    const mock = context();
    const result = await collectQualificationDiscoveryEvidence(mock.ctx, {
      ...prospect,
      linkedinUserUrn: undefined,
      data: { username: "educator" },
    });
    expect(result?.profileData.urn).toBe("ACo123");
    expect(mock.runMutation).toHaveBeenCalledOnce();
  });
});

describe("verified current employer context", () => {
  const company = {
    id: "42",
    name: "Courses",
    linkedinUrl: "https://www.linkedin.com/company/courses/",
    website: "https://courses.example",
    description: "Commercial learning software",
    headquarter: { city: "Paris", country: "FR", countryCode: "FR" },
    industriesV2: ["Software"],
  };
  const employerProfile = {
    ...profile,
    currentPositions: [{ company: { id: "42" } }],
    position: [
      { ...profile.position[0], companyId: 99, end: { year: 2020 } },
      { ...profile.position[0], companyId: 42, end: { year: 0 } },
    ],
  };
  const socialProspect = {
    ...prospect,
    discoverySource: "search_post" as const,
  };

  test("uses the exact current employer and keeps company facts out of personal quote text", async () => {
    const mock = context();
    mock.runAction
      .mockReset()
      .mockResolvedValueOnce({ success: true, profile: employerProfile })
      .mockResolvedValueOnce({ success: true, company });
    vi.mocked(readWebPages).mockResolvedValueOnce([
      {
        url: company.website,
        title: "Courses",
        snippet: "Official commercial software description.",
      },
    ]);
    const result = await collectQualificationDiscoveryEvidence(
      mock.ctx,
      socialProspect
    );
    expect(mock.runAction.mock.calls[1][1]).toEqual({ id: "42" });
    expect(mock.runAction).toHaveBeenCalledTimes(2);
    expect(readWebPages).toHaveBeenCalledExactlyOnceWith(
      [company.website],
      expect.objectContaining({
        consumer: "qualification.employer_website",
        prospectId: prospect._id,
      })
    );
    expect(result?.profileData.employerEvidence).toMatchObject({
      companyId: "42",
      sourceUrl: company.linkedinUrl,
      relationshipSourceUrl: "https://www.linkedin.com/in/educator",
      fetchedAt: expect.any(String),
      company: {
        name: "Courses",
        website: company.website,
        headquarter: { countryCode: "FR" },
        industries: ["Software"],
      },
      officialWebsiteEvidence: {
        url: company.website,
        text: "Official commercial software description.",
        retrievedAt: expect.any(String),
      },
    });
    expect(getQualificationProfileText(result!.profileData)).not.toContain(
      company.description
    );
    expect(getQualificationProfileText(result!.profileData)).not.toContain(
      company.website
    );
    expect(getQualificationProfileText(result!.profileData)).not.toContain(
      "Official commercial software description."
    );
    expect(mock.runMutation.mock.calls[0][1]).toMatchObject({
      expectedTargetingFingerprint: expect.any(String),
      profileData: {
        qualificationContextVersion: 2,
        employerEvidence: { companyId: "42" },
      },
    });
  });

  test.each([
    {
      currentPositions: [{ company: { id: "42" } }, { company: { id: "99" } }],
    },
    { currentPositions: [{ company: { id: "42" } }, { company: {} }] },
    { currentPositions: [] },
    { position: [{ companyId: 42, end: { year: 2020 } }] },
    { position: [{ companyId: 42 }] },
  ])(
    "leaves ambiguous or historical employer facts unknown",
    async (positions) => {
      const mock = context();
      mock.runAction.mockReset().mockResolvedValueOnce({
        success: true,
        profile: { ...profile, ...positions },
      });
      const result = await collectQualificationDiscoveryEvidence(
        mock.ctx,
        socialProspect
      );
      expect(result?.profileData.employerEvidence).toBeUndefined();
      expect(mock.runAction).toHaveBeenCalledOnce();
    }
  );

  test("deduplicates multiple current roles at one company when currentPositions is absent", async () => {
    const mock = context();
    mock.runAction
      .mockReset()
      .mockResolvedValueOnce({
        success: true,
        profile: {
          ...profile,
          position: [
            { companyId: 42, end: { year: 0 }, title: "Instructor" },
            { companyId: 42, end: { year: 0 }, title: "Founder" },
            { companyId: 99, end: { year: 2020 }, title: "Former role" },
          ],
        },
      })
      .mockResolvedValueOnce({ success: true, company });
    const result = await collectQualificationDiscoveryEvidence(
      mock.ctx,
      socialProspect
    );
    expect(result?.profileData.employerEvidence).toMatchObject({
      companyId: "42",
    });
    expect(mock.runAction).toHaveBeenCalledTimes(2);
  });

  test.each([
    { success: false, error: "429 provider rate limited" },
    { success: true, company: { ...company, id: "other" } },
    {
      success: true,
      company: {
        ...company,
        linkedinUrl: "https://other.example/company/courses",
      },
    },
  ])(
    "company lookup failures defer instead of caching false absence",
    async (response) => {
      const mock = context();
      mock.runAction
        .mockReset()
        .mockResolvedValueOnce({ success: true, profile: employerProfile })
        .mockResolvedValueOnce(response);
      await expect(
        collectQualificationDiscoveryEvidence(mock.ctx, socialProspect)
      ).rejects.toThrow("QualificationEvidence");
      expect(mock.runMutation).not.toHaveBeenCalled();
    }
  );

  test("refreshes an old sanitized cache once, then reuses employer facts without provider calls", async () => {
    const mock = context();
    mock.runAction
      .mockReset()
      .mockResolvedValueOnce({ success: true, profile: employerProfile })
      .mockResolvedValueOnce({ success: true, company });
    const result = await collectQualificationDiscoveryEvidence(mock.ctx, {
      ...socialProspect,
      qualificationProfileData: profile,
      qualificationEvidenceFetchedAt: 1,
    });
    mock.runAction.mockClear();
    const cached = await collectQualificationDiscoveryEvidence(mock.ctx, {
      ...socialProspect,
      qualificationProfileData: result!.profileData,
      qualificationEvidenceFetchedAt: 2,
    });
    expect(cached?.profileData.employerEvidence).toEqual(
      result?.profileData.employerEvidence
    );
    expect(mock.runAction).not.toHaveBeenCalled();
  });

  test("preserves matching manually verified legal evidence through an old-cache refresh", async () => {
    const mock = context();
    const officialWebsiteEvidence = {
      url: "https://www.courses.example/mentions-legales",
      retrievedAt: "2026-11-03T20:00:00Z",
      text: "Courses SAS, registered in France.",
    };
    mock.runAction
      .mockReset()
      .mockResolvedValueOnce({ success: true, profile: employerProfile })
      .mockResolvedValueOnce({ success: true, company });
    const result = await collectQualificationDiscoveryEvidence(mock.ctx, {
      ...socialProspect,
      qualificationProfileData: {
        ...profile,
        employerEvidence: { companyId: "42", officialWebsiteEvidence },
      },
      qualificationEvidenceFetchedAt: 1,
    });
    expect(result?.profileData.employerEvidence).toMatchObject({
      officialWebsiteEvidence,
    });
    expect(readWebPages).not.toHaveBeenCalled();
    expect(mock.runAction.mock.calls[1][1]).toEqual({ id: "42" });
  });

  test("does not reuse website evidence from a different company host", async () => {
    const mock = context();
    mock.runAction
      .mockReset()
      .mockResolvedValueOnce({ success: true, profile: employerProfile })
      .mockResolvedValueOnce({ success: true, company });
    const result = await collectQualificationDiscoveryEvidence(mock.ctx, {
      ...socialProspect,
      qualificationProfileData: {
        ...profile,
        employerEvidence: {
          companyId: "42",
          officialWebsiteEvidence: {
            url: "https://other.example/legal",
            text: "Other business",
          },
        },
      },
      qualificationEvidenceFetchedAt: 1,
    });
    expect(result?.profileData.employerEvidence).not.toHaveProperty(
      "officialWebsiteEvidence"
    );
    expect(readWebPages).toHaveBeenCalledOnce();
  });

  test("website provider errors defer without caching a false negative", async () => {
    const mock = context();
    mock.runAction
      .mockReset()
      .mockResolvedValueOnce({ success: true, profile: employerProfile })
      .mockResolvedValueOnce({ success: true, company });
    vi.mocked(readWebPages).mockResolvedValueOnce([
      {
        url: company.website,
        title: "",
        snippet: "",
        error: "503 unavailable",
      },
    ]);
    await expect(
      collectQualificationDiscoveryEvidence(mock.ctx, socialProspect)
    ).rejects.toThrow("503 unavailable");
    expect(mock.runMutation).not.toHaveBeenCalled();
  });

  test.each([
    "Website returned HTTP 404",
    "Website returned HTTP 403",
    "Invalid URL format",
    "Could not extract sufficient content from URL",
  ])(
    "unreadable company website leaves sourced employer facts available: %s",
    async (error) => {
      const mock = context();
      const sourcePost = {
        id: "request",
        text: "I need SEO help",
        author: { urn: "ACo123" },
      };
      mock.runAction
        .mockReset()
        .mockResolvedValueOnce({ success: true, profile: employerProfile })
        .mockResolvedValueOnce({ success: true, company });
      vi.mocked(readWebPages).mockResolvedValueOnce([
        { url: company.website, title: "", snippet: "", error },
      ]);
      const result = await collectQualificationDiscoveryEvidence(mock.ctx, {
        ...socialProspect,
        evidencePosts: [sourcePost],
      });
      expect(result?.evidencePosts).toEqual([sourcePost]);
      expect(result?.profileData.employerEvidence).toMatchObject({
        companyId: "42",
        company: { name: "Courses" },
        websiteReadError: error,
      });
      expect(result?.profileData.employerEvidence).not.toHaveProperty(
        "officialWebsiteEvidence"
      );
      expect(mock.runMutation).toHaveBeenCalledOnce();
    }
  );

  test("company accounts are skipped before the person endpoint", async () => {
    const mock = context();
    expect(
      await collectQualificationDiscoveryEvidence(mock.ctx, {
        ...socialProspect,
        socialProfiles: {
          linkedin: { username: "courses", url: company.linkedinUrl },
        },
      })
    ).toBeNull();
    expect(mock.runAction).not.toHaveBeenCalled();
  });

  test("read-only re-evaluation of an already decided prospect does not overwrite its cache", async () => {
    const mock = context();
    mock.runAction
      .mockReset()
      .mockResolvedValueOnce({ success: true, profile: employerProfile })
      .mockResolvedValueOnce({ success: true, company });
    const result = await collectQualificationDiscoveryEvidence(mock.ctx, {
      ...socialProspect,
      qualificationStatus: "disqualified",
    });
    expect(result?.profileData.employerEvidence).toMatchObject({
      companyId: "42",
    });
    expect(mock.runMutation).not.toHaveBeenCalled();
  });
});

test.each([
  { ...profile, username: undefined },
  { ...profile, username: "urn:li:fsd_profile:ACo123" },
  { ...profile, username: "bad/name" },
  { ...profile, urn: undefined },
  { ...profile, urn: "   " },
])(
  "incomplete provider identifiers do not fetch posts or persist fabricated URLs",
  async (incompleteProfile) => {
    const mock = context();
    mock.runAction
      .mockReset()
      .mockResolvedValueOnce({ success: true, profile: incompleteProfile });
    const seed = {
      ...prospect,
      linkedinUserUrn: undefined,
      data: { urn: String(profile.id) },
    };
    // Identity can still be verified through the stable numeric provider ID.
    await expect(
      collectQualificationDiscoveryEvidence(mock.ctx, seed)
    ).rejects.toThrow("valid public username or URN");
    expect(mock.runAction).toHaveBeenCalledOnce();
    expect(mock.runMutation).not.toHaveBeenCalled();
  }
);
test("a known username remains usable when the provider returns only the matching URN", async () => {
  const mock = context();
  mock.runAction
    .mockReset()
    .mockResolvedValueOnce({
      success: true,
      profile: { ...profile, username: undefined },
    })
    .mockResolvedValueOnce({ posts: [] });
  const result = await collectQualificationDiscoveryEvidence(
    mock.ctx,
    prospect
  );
  expect(result?.profileData.url).toBe("https://www.linkedin.com/in/educator");
});
