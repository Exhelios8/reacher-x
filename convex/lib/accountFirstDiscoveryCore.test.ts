import { afterEach, expect, test, vi } from "vitest";
import {
  ACCOUNT_RESEARCH_LOOKBACK_MS,
  buildAccountResearchQueries,
  groundAccountQuery,
  isAccountFirstDiscoveryEnabled,
  isAccountResearchHintFromFindings,
  isFreshAccountResearchHint,
  selectRecentAccountFindings,
} from "./accountFirstDiscoveryCore";
import { buildLegacyWorkspaceTargetingSpec } from "./targetingSpecCore";

const now = Date.parse("2026-11-05T12:00:00Z");
const finding = {
  title: "Acme ouvre une nouvelle usine",
  url: "https://www.acme.fr/actualites/usine",
  publishedDate: "2026-11-01",
  snippet: "Acme annonce une nouvelle usine en France.",
};
afterEach(() => vi.unstubAllEnvs());

test("account lookups rotate compact supplied work topics in the target language", () => {
  const spec = buildLegacyWorkspaceTargetingSpec({
    description: "French commercial companies",
    profiles: [],
  });
  const topics = [
    "migration documentation API",
    "pages catégories",
    "nouvelle gamme catalogue",
    "nouvelle offre conseil",
  ];
  spec.searchHints.activityPhrases = topics;
  spec.searchHints.languageCodes = ["fr", "en"];
  spec.searchFilters!.linkedinPeople.location = "France";
  const args = { targetingSpec: spec, keywords: ["current pages"], now };
  const first = buildAccountResearchQueries(args);
  const next = buildAccountResearchQueries({
    ...args,
    now: now + 5 * 60 * 1000,
  });
  expect(first).toHaveLength(2);
  expect(new Set([...first, ...next]).size).toBe(4);
  expect(
    first.every((query) => topics.some((topic) => query.startsWith(topic)))
  ).toBe(true);
  expect(
    first.every(
      (query) =>
        query.endsWith("France actualités entreprise site officiel") &&
        query.length < 220
    )
  ).toBe(true);
  expect(first.join(" ")).not.toMatch(
    /hiring|investment|launch|fundrais|criteria|budget/
  );
  expect(buildAccountResearchQueries({ keywords: [], now })).toEqual([]);
});

test("account research is disabled by default and allows only exact workspace IDs", () => {
  vi.stubEnv("ACCOUNT_FIRST_DISCOVERY_WORKSPACE_IDS", "");
  expect(isAccountFirstDiscoveryEnabled("workspace-1")).toBe(false);
  vi.stubEnv(
    "ACCOUNT_FIRST_DISCOVERY_WORKSPACE_IDS",
    " workspace-1,workspace-2 "
  );
  expect(isAccountFirstDiscoveryEnabled("workspace-1")).toBe(true);
  expect(isAccountFirstDiscoveryEnabled("workspace")).toBe(false);
  expect(isAccountFirstDiscoveryEnabled()).toBe(false);
});

test("research rejects missing/old/future dates, directories and supplier case studies", () => {
  const findings = [
    finding,
    {
      ...finding,
      url: "https://old.fr/news",
      publishedDate: new Date(
        now - ACCOUNT_RESEARCH_LOOKBACK_MS - 1
      ).toISOString(),
    },
    { ...finding, url: "https://future.fr/news", publishedDate: "2027-01-01" },
    { ...finding, url: "https://unknown.fr/news", publishedDate: undefined },
    { ...finding, url: "https://linkedin.com/posts/acme" },
    { ...finding, url: "https://supplier.fr/case-studies/acme" },
    { ...finding, url: "not a URL" },
    finding,
  ];
  expect(selectRecentAccountFindings(findings, now)).toEqual([finding]);
});

test("named queries need an observed source, matching employer text and issuer domain", () => {
  const query = {
    query: "Acme directeur marketing",
    accountName: "Acme",
    accountSourceUrl: finding.url,
  };
  const grounded = groundAccountQuery(query, [finding]);
  expect(grounded?.sourceKeyword).toContain(finding.url);
  expect(isFreshAccountResearchHint(grounded?.sourceKeyword, now)).toBe(true);
  expect(
    isAccountResearchHintFromFindings(grounded?.sourceKeyword, [finding], now)
  ).toBe(true);
  expect(
    isAccountResearchHintFromFindings(grounded?.sourceKeyword, [], now)
  ).toBe(false);
  expect(
    isFreshAccountResearchHint(
      grounded?.sourceKeyword,
      now + ACCOUNT_RESEARCH_LOOKBACK_MS
    )
  ).toBe(false);
  expect(
    groundAccountQuery({ ...query, accountName: "Invented" }, [finding])
  ).toBeNull();
  expect(
    groundAccountQuery({ ...query, query: "directeur marketing" }, [finding])
  ).toBeNull();
  expect(
    groundAccountQuery(query, [{ ...finding, url: "https://supplier.fr/news" }])
  ).toBeNull();
  expect(
    groundAccountQuery(
      { ...query, accountSourceUrl: "https://supplier.fr/news" },
      [{ ...finding, url: "https://supplier.fr/news" }]
    )
  ).toBeNull();
});
