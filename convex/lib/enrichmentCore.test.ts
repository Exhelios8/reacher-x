// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import { robustGenerateObject } from "./ai";
import { enrichLinkedInProfile } from "./enrichmentCore";

vi.mock("./ai", () => ({ robustGenerateObject: vi.fn() }));
vi.mock("./contactDiscoveryCore", () => ({
  discoverPublicContactInfo: vi.fn(async () => ({})),
}));

afterEach(() => vi.clearAllMocks());

function mockExtraction(finance: Record<string, unknown>) {
  vi.mocked(robustGenerateObject).mockImplementation(async ({ schema }) => ({
    object: schema.parse({
      prospectType: "individual",
      title: "Deputy CEO",
      company: "Sairen",
      painPoints: [],
      finance,
    }),
    model: "local-fixture",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  }));
}

const profile = {
  firstName: "Fixture",
  lastName: "Person",
  headline: "Deputy CEO at Sairen / Looking for B2B SaaS with $1-5M ARR",
  employerEvidence: {
    companyId: "42",
    sourceUrl: "https://www.linkedin.com/company/sairen/",
    relationshipSourceUrl: "https://www.linkedin.com/in/fixture/",
    company: {
      name: "Sairen",
      description: "B2B SaaS group",
      website: "https://www.sairen.io/",
    },
  },
};

const params = {
  profile,
  evidencePosts: [],
  icps: [],
  workspaceName: "Pharelia",
};

describe("finance attribution", () => {
  test.each([
    ["acquisition_target", profile.headline],
    ["client_or_third_party", "Helped a client reach $1.2M ARR"],
    ["target_or_budget", "Our goal is $1.2M ARR next year"],
    ["unknown", "$1.2M ARR"],
  ])("rejects %s finance", async (attribution, headline) => {
    mockExtraction({
      found: true,
      attribution,
      displayValue: "Looking for B2B SaaS with $1M–$5M ARR",
      type: "arr",
      currency: "USD",
      postIds: [],
    });

    const result = await enrichLinkedInProfile({
      ...params,
      profile: { ...profile, headline },
    });

    expect(result.enrichmentStatus).toBe("enriched");
    expect(result.finance).toBeUndefined();
    expect(vi.mocked(robustGenerateObject).mock.calls[0][0].prompt).toContain(
      headline
    );
  });

  test("retains actual own-company ARR and its source post", async () => {
    const post = {
      id: "own-arr",
      text: "We reached $1.2M ARR at Sairen.",
      platform: "linkedin" as const,
      url: "https://www.linkedin.com/posts/fixture",
    };
    mockExtraction({
      found: true,
      attribution: "own_actual",
      displayValue: "$1.2M ARR",
      type: "arr",
      amount: 1_200_000,
      currency: "USD",
      postIds: [post.id],
    });

    const result = await enrichLinkedInProfile({
      ...params,
      evidencePosts: [post],
    });

    expect(result.finance).toEqual({
      displayValue: "$1.2M ARR",
      type: "arr",
      amount: 1_200_000,
      currency: "USD",
      evidencePosts: [post],
    });
  });

  test("preserves funding supplied directly by the company's API record", async () => {
    mockExtraction({ found: false, attribution: "unknown" });

    const result = await enrichLinkedInProfile({
      ...params,
      companyData: {
        name: "Sairen",
        linkedinUrl: "https://www.linkedin.com/company/sairen/",
        fundingData: {
          lastFundingRound: {
            moneyRaised: { amount: "5000000", currencyCode: "USD" },
            fundingType: "Series A",
          },
        },
      },
    });

    expect(result.finance).toMatchObject({
      type: "funding",
      amount: 5_000_000,
      currency: "USD",
      evidencePosts: [],
    });
  });
});

describe("LinkedIn employer context", () => {
  test("keeps employer evidence separate and uses its website without renaming the person", async () => {
    mockExtraction({ found: false, attribution: "unknown" });

    const result = await enrichLinkedInProfile(params);

    expect(result).toMatchObject({
      prospectType: "individual",
      displayName: "Fixture Person",
      company: "Sairen",
      websiteUrl: "https://www.sairen.io/",
    });
    const prompt = vi.mocked(robustGenerateObject).mock.calls[0][0].prompt;
    expect(prompt).toContain("Current employer evidence");
    expect(prompt).toContain(profile.employerEvidence.sourceUrl);
    expect(prompt).toContain(profile.employerEvidence.relationshipSourceUrl);
    expect(prompt).toContain(profile.employerEvidence.company.description);
  });

  test.each([
    [undefined, "https://profile.example/"],
    ["https://contact.example/", "https://contact.example/"],
  ])(
    "prefers actual profile/contact websites over employer",
    async (contactUrl, expected) => {
      mockExtraction({ found: false, attribution: "unknown" });

      const result = await enrichLinkedInProfile({
        ...params,
        profile: { ...profile, website: "https://profile.example/" },
        contactInfo: contactUrl
          ? { websites: [{ url: contactUrl }] }
          : undefined,
      });

      expect(result.websiteUrl).toBe(expected);
    }
  );

  test("rejects non-HTTP employer websites", async () => {
    mockExtraction({ found: false, attribution: "unknown" });

    const result = await enrichLinkedInProfile({
      ...params,
      profile: {
        ...profile,
        employerEvidence: {
          ...profile.employerEvidence,
          company: {
            ...profile.employerEvidence.company,
            website: "javascript:alert(1)",
          },
        },
      },
    });

    expect(result.websiteUrl).toBeUndefined();
  });
});
