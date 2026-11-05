import type { WorkspaceTargetingSpec } from "./targetingSpecCore";
import type { ResearchFinding } from "./researchCore";
import { createStableHash } from "./memoryHelpers";

export const ACCOUNT_RESEARCH_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const ACCOUNT_HINT_PREFIX = "account_research_hint:";
const EXCLUDED_DOMAINS = [
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "crunchbase.com",
  "pappers.fr",
  "societe.com",
  "wikipedia.org",
];

export function isAccountFirstDiscoveryEnabled(workspaceId?: string): boolean {
  return Boolean(
    workspaceId &&
    process.env.ACCOUNT_FIRST_DISCOVERY_WORKSPACE_IDS?.split(",")
      .map((id) => id.trim())
      .includes(workspaceId)
  );
}

export function buildAccountResearchQueries(args: {
  targetingSpec?: WorkspaceTargetingSpec;
  keywords: string[];
  now: number;
}): string[] {
  const spec = args.targetingSpec;
  const suppliedActivities = spec?.searchHints.activityPhrases ?? [];
  const intentTerms =
    spec?.criteria
      .filter(
        (criterion) =>
          criterion.category === "intent" && criterion.kind !== "exclusion"
      )
      .flatMap((criterion) => criterion.terms) ?? [];
  const phrases = [
    ...new Set(
      (suppliedActivities.length
        ? suppliedActivities
        : intentTerms.length
          ? intentTerms
          : args.keywords
      )
        .map((phrase) => phrase.replace(/\s+/g, " ").trim().slice(0, 160))
        .filter(Boolean)
    ),
  ];
  if (!phrases.length) return [];
  const location =
    spec?.searchHints.locations[0] ??
    spec?.searchFilters?.linkedinPeople.location ??
    "";
  const sourceTerms =
    spec?.searchHints.languageCodes?.[0] === "fr"
      ? "actualités entreprise site officiel"
      : "company official news";
  // Rotate supplied work/page topics across cycles without adding a model call or durable state.
  const offset =
    (parseInt(createStableHash(args.keywords.join("\n")), 16) +
      Math.floor(args.now / (5 * 60 * 1000))) %
    phrases.length;
  return Array.from({ length: Math.min(2, phrases.length) }, (_, index) =>
    [
      phrases[
        (offset + index * Math.ceil(phrases.length / 2)) % phrases.length
      ],
      location,
      sourceTerms,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

export function selectRecentAccountFindings(
  findings: ResearchFinding[],
  now: number
): ResearchFinding[] {
  const seen = new Set<string>();
  return findings
    .filter((finding) => {
      try {
        const url = new URL(finding.url);
        const date = Date.parse(finding.publishedDate ?? "");
        if (
          !/^https?:$/.test(url.protocol) ||
          !finding.title.trim() ||
          !finding.snippet.trim() ||
          !Number.isFinite(date) ||
          date < now - ACCOUNT_RESEARCH_LOOKBACK_MS ||
          date > now ||
          EXCLUDED_DOMAINS.some(
            (domain) =>
              url.hostname === domain || url.hostname.endsWith(`.${domain}`)
          ) ||
          /case[-_ ]?stud|cas[-_ ]client|temoignage|testimonial|portfolio/i.test(
            url.pathname
          ) ||
          seen.has(url.href)
        )
          return false;
        seen.add(url.href);
        return true;
      } catch {
        return false;
      }
    })
    .slice(0, 4)
    .map((finding) => ({
      ...finding,
      snippet: finding.snippet.slice(0, 1_200),
    }));
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Research provenance only: the qualifier still verifies employer, geography and event. */
export function groundAccountQuery<
  T extends { query: string; accountName?: string; accountSourceUrl?: string },
>(
  item: T,
  findings: ResearchFinding[]
): (T & { sourceKeyword: string }) | null {
  const finding = findings.find(
    (finding) => finding.url === item.accountSourceUrl
  );
  const name = item.accountName?.trim();
  if (
    !finding ||
    !name ||
    normalizeName(item.query) === normalizeName(name) ||
    !normalizeName(item.query).includes(normalizeName(name)) ||
    !normalizeName(`${finding.title} ${finding.snippet}`).includes(
      normalizeName(name)
    )
  )
    return null;
  const host = normalizeName(
    new URL(finding.url).hostname
      .replace(/^www\./, "")
      .split(".")
      .slice(0, -1)
      .join(" ")
  );
  const nameTokens = name
    .split(/\s+/)
    .map(normalizeName)
    .filter(
      (token) =>
        token.length >= 3 &&
        !["groupe", "group", "company", "france", "sas", "sarl"].includes(token)
    );
  if (!nameTokens.some((token) => host.includes(token))) return null;
  return {
    ...item,
    sourceKeyword: `${ACCOUNT_HINT_PREFIX}${Date.parse(finding.publishedDate ?? "")}|${finding.url}`,
  };
}

export function isFreshAccountResearchHint(
  source: string | undefined,
  now: number
): boolean {
  if (!source?.startsWith(ACCOUNT_HINT_PREFIX)) return false;
  const [date, url] = source.slice(ACCOUNT_HINT_PREFIX.length).split("|");
  const publishedAt = Number(date);
  return (
    Number.isFinite(publishedAt) &&
    publishedAt >= now - ACCOUNT_RESEARCH_LOOKBACK_MS &&
    publishedAt <= now &&
    Boolean(url && /^https?:\/\//.test(url))
  );
}

export function isAccountResearchHintFromFindings(
  source: string | undefined,
  findings: ResearchFinding[],
  now: number
): boolean {
  return (
    isFreshAccountResearchHint(source, now) &&
    findings.some(
      (finding) =>
        source ===
        `${ACCOUNT_HINT_PREFIX}${Date.parse(finding.publishedDate ?? "")}|${finding.url}`
    )
  );
}
