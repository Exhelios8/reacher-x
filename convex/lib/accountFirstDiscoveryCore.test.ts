import { afterEach, expect, test, vi } from "vitest";
import {
  ACCOUNT_RESEARCH_LOOKBACK_MS,
  buildAccountResearchQueries,
  groundAccountQuery,
  isAccountFirstDiscoveryEnabled,
  isAccountResearchHintFromFindings,
  isFreshAccountResearchHint,
  selectRecentAccountFindings,
  parseAccountPeopleQuery,
  isVerifiedAccountCompany,
  isUnsearchedAccountResearchHint,
} from "./accountFirstDiscoveryCore";
import { buildLegacyWorkspaceTargetingSpec } from "./targetingSpecCore";

const now = Date.parse("2026-11-05T12:00:00Z");
const finding = {
  title: "Acme ouvre une nouvelle usine",
  url: "https://www.acme.fr/actualites/usine",
  publishedDate: "2026-11-01",
  snippet: "Acme annonce une nouvelle usine en France.",
};

test("account binding requires an exact named employer, allowed role, and official domain", () => {
  const source = `account_retrieval_hint:${now}|https://agent-factory.fr/offre`;
  const account = parseAccountPeopleQuery(
    "Agent Factory fondateur",
    source,
    ["fondateur"],
    now
  )!;
  expect(account).toEqual({
    name: "Agent Factory",
    title: "fondateur",
    sourceUrl: "https://agent-factory.fr/offre",
  });
  expect(
    parseAccountPeopleQuery("fondateur", source, ["fondateur"], now)
  ).toBeNull();
  expect(
    parseAccountPeopleQuery(
      "Agent Factory stagiaire",
      source,
      ["fondateur"],
      now
    )
  ).toBeNull();
  expect(
    isVerifiedAccountCompany(account, {
      id: "123",
      name: "Agent Factory",
      website: "https://www.agent-factory.fr",
    })
  ).toBe(true);
  expect(
    isVerifiedAccountCompany(account, {
      id: "123",
      name: "Agent Factory",
      website: "https://agent-factory.com",
    })
  ).toBe(false);
  expect(
    isVerifiedAccountCompany(
      { ...account, name: "Group" },
      { id: "123", name: "Group Division", website: account.sourceUrl }
    )
  ).toBe(false);
  expect(isUnsearchedAccountResearchHint(source, now - 1)).toBe(true);
  expect(isUnsearchedAccountResearchHint(source, now)).toBe(false);
});

test("planner acceptance emits the same exact company-role form execution can parse", () => {
  const spec = buildLegacyWorkspaceTargetingSpec({
    description: "France",
    profiles: [],
  });
  spec.discoveryMode = "peer_or_site_audit";
  spec.searchHints.roleTitles = ["directeur marketing"];
  const offer = { ...finding, retrievedAt: new Date(now).toISOString() };
  const input = {
    query: "ACME directeur marketing",
    accountName: "Acme",
    accountSourceUrl: offer.url,
  };
  const grounded = groundAccountQuery(input, [offer], spec)!;
  expect(grounded.query).toBe("Acme directeur marketing");
  expect(
    parseAccountPeopleQuery(
      grounded.query,
      grounded.sourceKeyword,
      spec.searchHints.roleTitles,
      now
    )
  ).toMatchObject({ name: "Acme", title: "directeur marketing" });
  expect(
    groundAccountQuery(
      { ...input, query: "Acme directeur marketing France" },
      [offer],
      spec
    )
  ).toBeNull();
});
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

test("peer-or-site-audit rotates one evergreen offer and one independent site exploration", () => {
  const spec = buildLegacyWorkspaceTargetingSpec({
    description: "French businesses",
    profiles: [],
  });
  spec.discoveryMode = "peer_or_site_audit";
  spec.searchHints.peerOfferPhrases = [
    "plateforme agents IA entreprise",
    "API voix temps réel",
  ];
  spec.searchHints.activityPhrases = [
    "catalogue distributeur professionnel",
    "réseau agences services locales",
  ];
  spec.searchHints.languageCodes = ["fr"];
  spec.searchHints.locations = ["France"];
  const args = { targetingSpec: spec, keywords: ["site"], now };
  const queries = buildAccountResearchQueries(args);
  expect(queries).toHaveLength(2);
  expect(
    spec.searchHints.peerOfferPhrases.some((phrase) =>
      queries[0].startsWith(phrase)
    )
  ).toBe(true);
  expect(
    spec.searchHints.activityPhrases.some((phrase) =>
      queries[1].startsWith(phrase)
    )
  ).toBe(true);
  expect(queries.every((query) => query.endsWith("France site officiel"))).toBe(
    true
  );
  expect(queries.join(" ")).not.toMatch(/actualit|news|fundrais|hiring/);
  const next = buildAccountResearchQueries({
    ...args,
    now: now + 5 * 60 * 1000,
  });
  expect(new Set([...queries, ...next]).size).toBe(4);
});

test("an undated own offer is a short-lived retrieval hint, never a published event", () => {
  const spec = buildLegacyWorkspaceTargetingSpec({
    description: "French businesses",
    profiles: [],
  });
  spec.discoveryMode = "peer_or_site_audit";
  spec.searchHints.excludedCompanyDomains = ["client.fr"];
  const offer = {
    title: "Acme logiciels de gestion",
    url: "https://acme.fr/produits",
    snippet: "Acme vend un logiciel de gestion pour les PME.",
  };
  const findings = selectRecentAccountFindings(
    [
      offer,
      { ...offer, url: "https://portal.client.fr/offre" },
      { ...offer, url: "https://client.fr/offre" },
      { ...offer, url: "https://supplier.fr/case-studies/acme" },
      { ...offer, url: "https://linkedin.com/company/acme" },
    ],
    now,
    spec
  );
  expect(findings).toEqual([
    { ...offer, retrievedAt: new Date(now).toISOString() },
  ]);
  expect(findings[0].publishedDate).toBeUndefined();
  const grounded = groundAccountQuery(
    {
      query: "Acme directeur marketing",
      accountName: "Acme",
      accountSourceUrl: offer.url,
    },
    findings,
    spec
  );
  expect(grounded?.sourceKeyword).toBe(
    `account_retrieval_hint:${now}|${offer.url}`
  );
  expect(isFreshAccountResearchHint(grounded?.sourceKeyword, now)).toBe(true);
  expect(
    isFreshAccountResearchHint(grounded?.sourceKeyword, now + 86_400_001)
  ).toBe(false);
  expect(
    isAccountResearchHintFromFindings(grounded?.sourceKeyword, findings, now)
  ).toBe(true);
  expect(
    isAccountResearchHintFromFindings(grounded?.sourceKeyword, [offer], now)
  ).toBe(false);
  expect(
    groundAccountQuery(
      {
        query: "Acme directeur marketing",
        accountName: "Acme",
        accountSourceUrl: offer.url,
      },
      findings
    )
  ).toBeNull();
});

test("V3 never falls back to reference names, entities or generated keywords as seed accounts", () => {
  const spec = buildLegacyWorkspaceTargetingSpec({
    description: "French businesses",
    profiles: [],
  });
  spec.discoveryMode = "peer_or_site_audit";
  spec.searchHints.activityPhrases = [];
  spec.searchHints.entities = ["Reference account"];
  spec.searchHints.companyNames = ["Reference account"];
  expect(
    buildAccountResearchQueries({
      targetingSpec: spec,
      keywords: ["Reference account"],
      now,
    })
  ).toEqual([]);
  spec.searchHints.peerOfferPhrases = ["logiciel de gestion professionnelle"];
  expect(
    buildAccountResearchQueries({
      targetingSpec: spec,
      keywords: ["Reference account"],
      now,
    })
  ).toEqual(["logiciel de gestion professionnelle official website"]);
});
