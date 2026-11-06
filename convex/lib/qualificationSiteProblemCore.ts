import { isPublicHttpUrl } from "../../shared/lib/utils/url/urlSafety";
import { sameQualificationWebsiteHost } from "./qualificationEvidenceCore";

export type ObservedSiteProblem = {
  evidenceKind: "observed_site_problem";
  companyId: string;
  url: string;
  finalUrl: string;
  targetUrl: string;
  anchorText: string;
  httpStatus: 404 | 410;
  observedAt: string;
  text: string;
};

export class QualificationSiteProblemRetryableError extends Error {
  constructor() {
    super("[QualificationEvidence] Temporary site observation failure");
    this.name = "QualificationSiteProblemRetryableError";
  }
}

const COMMERCIAL_OR_DOC_ROUTE =
  /\/(?:docs?|documentation|products?|produits?|solutions?|services?|offres?|support|help|assistance|guides?|integrations?|use-cases?|developers?|api-reference)(?:\/|$)/i;
const PRIVATE_OR_ACTION_ROUTE =
  /\/(?:auth|login|log-in|signin|sign-in|signup|sign-up|account|accounts|admin|wp-admin|wp-login|checkout|cart|panier|dashboard|portal|portail|private|internal|interne|members?|restricted|confidential|prive|privé|preview|draft|logout|unsubscribe|_next|_astro|assets|api)(?:[/.;]|$)/i;
const AUTH_OR_CHALLENGE =
  /authentication required|please (?:log|sign) in|sign in to (?:continue|access)|access denied|cloudflare access|captcha|too many requests|rate limit|just a moment/i;
const REPLACEMENT_NOTICE =
  /(?:page|documentation|resource|content|url|address).{0,70}(?:has (?:been )?(?:moved|renamed|replaced)|moved permanently)|(?:page|documentation|ressource|contenu|adresse).{0,70}(?:d[eé]plac[eé]|renomm[eé]|remplac[eé])|(?:new url|new address|nouvelle adresse)/i;
const ASSET_EXTENSION =
  /\.(?:pdf|zip|gz|tar|csv|txt|json|xml|png|jpe?g|gif|svg|webp|avif|ico|css|[cm]?js|map|woff2?|ttf|eot|mp[34]|webm)$/i;
const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

function safeOfficialUrl(
  value: string,
  officialWebsite: string
): string | undefined {
  try {
    const url = new URL(value, officialWebsite);
    const official = new URL(officialWebsite);
    const path = decodeURIComponent(url.pathname);
    if (
      !isPublicHttpUrl(url.href) ||
      url.username ||
      url.password ||
      !sameQualificationWebsiteHost(url.href, officialWebsite) ||
      url.port !== official.port ||
      url.search ||
      path.includes("%") ||
      path.includes("\\") ||
      PRIVATE_OR_ACTION_ROUTE.test(path) ||
      ASSET_EXTENSION.test(path)
    )
      return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number
): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let remaining = maxBytes;
  try {
    while (remaining > 0) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, remaining);
      remaining -= chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
    // A truncated document could hide a closing script, access warning or replacement URL.
    return remaining > 0 ? text + decoder.decode() : undefined;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function htmlAttributes(value: string): Map<string, string> | undefined {
  if (value.length > 4000) return undefined;
  const attributes = new Map<string, string>();
  let raw = value.trim().replace(/\/$/, "").trim();
  while (raw) {
    const attribute = raw.match(
      /^([a-z_:][-a-z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'))?(?:\s+|$)/i
    );
    if (!attribute || attributes.has(attribute[1].toLowerCase()))
      return undefined;
    attributes.set(
      attribute[1].toLowerCase(),
      attribute[3] ?? attribute[4] ?? ""
    );
    raw = raw.slice(attribute[0].length).trim();
  }
  return attributes;
}

function hasAccessOrRedirectSignal(response: Response, html: string): boolean {
  for (const link of html.matchAll(
    /<link\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi
  )) {
    const attributes = htmlAttributes(link[1]);
    if (!attributes) {
      if (/\bcanonical\b/i.test(link[1])) return true;
      continue;
    }
    if (
      !attributes.get("rel")?.toLowerCase().split(/\s+/).includes("canonical")
    )
      continue;
    const canonical = attributes.get("href");
    if (!canonical || canonical.includes("&")) return true;
    try {
      if (new URL(canonical, response.url).href !== response.url) return true;
    } catch {
      return true;
    }
  }
  return (
    response.headers.has("www-authenticate") ||
    response.headers.has("retry-after") ||
    response.headers.has("location") ||
    response.headers.has("refresh") ||
    response.headers.get("cf-mitigated") === "challenge" ||
    /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(html) ||
    AUTH_OR_CHALLENGE.test(html) ||
    REPLACEMENT_NOTICE.test(html.replace(/<[^>]+>/g, " "))
  );
}

function hasExplicitAccessBarrier(response: Response, html: string): boolean {
  return (
    response.headers.has("www-authenticate") ||
    response.headers.has("location") ||
    response.headers.has("refresh") ||
    response.headers.get("cf-mitigated") === "challenge" ||
    /authentication required|please (?:log|sign) in|sign in to (?:continue|access)|access denied|cloudflare access|captcha|just a moment/i.test(
      html
    )
  );
}

function selectLinkedPage(
  html: string,
  sourceUrl: string,
  officialWebsite: string,
  includeResources = false,
  excludedUrls: string[] = []
): { url: string; text: string } | undefined {
  // shortcut: pages using <base> or ambiguous attributes are skipped until a full DOM reader is needed.
  if (/<base\b/i.test(html)) return undefined;
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!--[\s\S]*$/g, " ")
    .replace(
      /<(script|style|template|noscript|pre|code|textarea|xmp|title|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi,
      " "
    )
    .replace(
      /<(?:script|style|template|noscript|pre|code|textarea|xmp|title|footer|aside)\b[\s\S]*$/gi,
      " "
    );
  // Consume every opening tag so apparent anchors inside quoted attributes are not links.
  for (const anchor of cleaned.matchAll(
    /<([a-z][a-z0-9:-]*)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi
  )) {
    if (anchor[1].toLowerCase() !== "a") continue;
    const anchorBody = cleaned
      .slice(anchor.index! + anchor[0].length)
      .match(/^([\s\S]*?)<\/a\s*>/i)?.[1];
    if (anchorBody === undefined || /<a\b/i.test(anchorBody)) continue;
    const attributes = htmlAttributes(anchor[2]);
    if (
      !attributes ||
      ["hidden", "disabled", "download", "onclick"].some((key) =>
        attributes.has(key)
      ) ||
      attributes.get("aria-hidden") === "true" ||
      attributes.get("role") === "button" ||
      /display\s*:\s*none|visibility\s*:\s*hidden/i.test(
        attributes.get("style") ?? ""
      )
    )
      continue;
    const href = attributes.get("href");
    if (!href || href.startsWith("#") || href.includes("&")) continue;
    const target = safeOfficialUrl(href, sourceUrl);
    if (
      !target ||
      !sameQualificationWebsiteHost(target, officialWebsite) ||
      target === sourceUrl ||
      excludedUrls.includes(target) ||
      !(
        COMMERCIAL_OR_DOC_ROUTE.test(new URL(target).pathname) ||
        (includeResources &&
          /(?:\/(?:nos-solutions|notre-offre|nos-offres|prestations|expertises|features|platform|plateforme|resources|ressources|blog|learn)(?:\/|$)|solutions|services|offres|documentation|resources|ressources|blog)/i.test(
            `${new URL(target).pathname} ${anchorBody.replace(/<[^>]+>/g, " ")}`
          ))
      )
    )
      continue;
    const text = anchorBody
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (
      /\b(?:log ?in|sign ?in|se connecter|connexion|mon compte|espace client|private|priv[eé]|internal|interne)\b/i.test(
        text
      ) ||
      /\b(?:logo|favicon|icon|ic[oô]ne)\b/i.test(text)
    )
      continue;
    if (text) return { url: target, text: text.slice(0, 240) };
  }
  return undefined;
}

export type OfficialSiteReviewedPage = {
  url: string;
  finalUrl: string;
  title: string;
  observedAt: string;
  text: string;
  httpStatus: 200;
  provenance: "native_http";
};

export type OfficialSiteReview = {
  reviewedPages: OfficialSiteReviewedPage[];
  siteProblems: ObservedSiteProblem[];
  retryable: boolean;
};

function pageText(html: string): string {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!--[\s\S]*$/g, " ")
    .replace(
      /<(script|style|template|noscript|pre|code|textarea|xmp|title|footer|aside|nav|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,
      " "
    )
    .replace(
      /<(?:script|style|template|noscript|pre|code|textarea|xmp|title|footer|aside|nav|svg)\b[\s\S]*$/gi,
      " "
    );
  return cleaned
    .replace(/<(?:[^"'<>]|"[^"]*"|'[^']*')*>/g, " ")
    .replace(
      /&(?:nbsp|amp|quot|apos|lt|gt);/g,
      (entity) => HTML_ENTITIES[entity] ?? entity
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
}

function documentTitle(html: string): string {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!--[\s\S]*$/g, " ")
    .replace(
      /<(script|style|template|noscript|pre|code|textarea|xmp|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,
      " "
    )
    .replace(
      /<(?:script|style|template|noscript|pre|code|textarea|xmp|svg)\b[\s\S]*$/gi,
      " "
    );
  for (const tag of cleaned.matchAll(
    /<([a-z][a-z0-9:-]*)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi
  )) {
    if (tag[1].toLowerCase() !== "title") continue;
    const value = cleaned
      .slice(tag.index! + tag[0].length)
      .match(/^([^<>]*)<\/title\s*>/i)?.[1];
    return value === undefined ? "" : pageText(value).slice(0, 300);
  }
  return "";
}

/** A bounded first-party reading, including healthy pages. It asserts no defect or commercial impact. */
export async function reviewOfficialSitePages(args: {
  companyId: string;
  officialWebsite: string;
}): Promise<OfficialSiteReview> {
  const result: OfficialSiteReview = {
    reviewedPages: [],
    siteProblems: [],
    retryable: false,
  };
  const sourceUrl = safeOfficialUrl(args.officialWebsite, args.officialWebsite);
  if (!sourceUrl || !/^[1-9]\d*$/.test(args.companyId)) return result;
  const signal = AbortSignal.timeout(8_000);
  let calls = 0;
  const get = async (url: string) => {
    if (calls >= 3) return undefined;
    calls++;
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "ReacherX/1.0",
      },
    });
    const html = await readBoundedBody(response, 128 * 1024);
    if (html === undefined || hasExplicitAccessBarrier(response, html))
      return undefined;
    if (response.status === 429 || response.status >= 500) {
      result.retryable = true;
      return undefined;
    }
    if (
      response.url !== url ||
      !safeOfficialUrl(response.url, args.officialWebsite) ||
      hasAccessOrRedirectSignal(response, html)
    )
      return undefined;
    return { response, html };
  };
  const retain = (page: { response: Response; html: string }): boolean => {
    if (
      page.response.status !== 200 ||
      !/text\/html|application\/xhtml\+xml/i.test(
        page.response.headers.get("content-type") ?? ""
      )
    )
      return false;
    const title = documentTitle(page.html);
    const text = pageText(page.html);
    if (
      text.length < 40 ||
      /^(?:404\b|page not found\b|not found\b|page introuvable\b|page non trouv[eé]e\b|erreur\s*404\b)/i.test(
        `${title} ${text}`.trim()
      )
    )
      return false;
    result.reviewedPages.push({
      url: page.response.url,
      finalUrl: page.response.url,
      title,
      text,
      httpStatus: 200,
      observedAt: new Date().toISOString(),
      provenance: "native_http",
    });
    return true;
  };
  try {
    const source = await get(sourceUrl);
    if (!source || !retain(source)) return result;
    const visited = [sourceUrl];
    while (calls < 3) {
      const link = selectLinkedPage(
        source.html,
        sourceUrl,
        args.officialWebsite,
        true,
        visited
      );
      if (!link) break;
      visited.push(link.url);
      const target = await get(link.url);
      if (!target) continue;
      if (retain(target)) continue;
      const status = target.response.status;
      if (
        (status !== 404 && status !== 410) ||
        calls >= 3 ||
        !COMMERCIAL_OR_DOC_ROUTE.test(new URL(link.url).pathname)
      )
        continue;
      const confirmation = await get(link.url);
      if (!confirmation || confirmation.response.status !== status) continue;
      const observedAt = new Date().toISOString();
      const text = `Official page: ${sourceUrl}\nLinked commercial or documentation URL: ${link.url}\nLink label: ${link.text}\nObserved HTTP ${status}, confirmed by two GET requests.\nObserved at: ${observedAt}`;
      result.siteProblems.push({
        evidenceKind: "observed_site_problem",
        companyId: args.companyId,
        url: sourceUrl,
        finalUrl: sourceUrl,
        targetUrl: link.url,
        anchorText: link.text,
        httpStatus: status,
        observedAt,
        text,
      });
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error instanceof TypeError ||
        error.name === "AbortError" ||
        error.name === "TimeoutError")
    )
      result.retryable = true;
  }
  return result;
}

/** One public source plus two identical missing-page GETs; every uncertainty leaves no finding. */
export async function observeOfficialSiteProblem(args: {
  companyId: string;
  officialWebsite: string;
  sourceUrl: string;
}): Promise<ObservedSiteProblem | undefined> {
  const sourceUrl = safeOfficialUrl(args.sourceUrl, args.officialWebsite);
  if (!sourceUrl || !/^[1-9]\d*$/.test(args.companyId)) return undefined;
  const signal = AbortSignal.timeout(8_000);
  const get = (url: string) =>
    fetch(url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "ReacherX/1.0",
      },
    });
  try {
    const source = await get(sourceUrl);
    if (source.status === 429 || source.status >= 500) {
      const body = await readBoundedBody(source, 8 * 1024);
      if (body === undefined || hasExplicitAccessBarrier(source, body))
        return undefined;
      throw new QualificationSiteProblemRetryableError();
    }
    if (
      source.status !== 200 ||
      !safeOfficialUrl(source.url, args.officialWebsite) ||
      !/text\/html|application\/xhtml\+xml/i.test(
        source.headers.get("content-type") ?? ""
      )
    )
      return undefined;
    const html = await readBoundedBody(source, 128 * 1024);
    if (html === undefined || hasAccessOrRedirectSignal(source, html))
      return undefined;
    const link = selectLinkedPage(html, source.url, args.officialWebsite);
    if (!link) return undefined;
    let confirmedStatus: 404 | 410 | undefined;
    for (let check = 0; check < 2; check++) {
      const target = await get(link.url);
      if (target.status === 429 || target.status >= 500) {
        const body = await readBoundedBody(target, 8 * 1024);
        if (body === undefined || hasExplicitAccessBarrier(target, body))
          return undefined;
        throw new QualificationSiteProblemRetryableError();
      }
      if (![404, 410].includes(target.status) || target.url !== link.url)
        return undefined;
      const body = await readBoundedBody(target, 8 * 1024);
      if (
        body === undefined ||
        hasAccessOrRedirectSignal(target, body) ||
        (confirmedStatus !== undefined && confirmedStatus !== target.status)
      )
        return undefined;
      confirmedStatus = target.status as 404 | 410;
    }
    if (!confirmedStatus) return undefined;
    const observedAt = new Date().toISOString();
    const text = `Official page: ${source.url}\nLinked commercial or documentation URL: ${link.url}\nLink label: ${link.text}\nObserved HTTP ${confirmedStatus}, confirmed by two GET requests.\nObserved at: ${observedAt}`;
    return {
      evidenceKind: "observed_site_problem",
      companyId: args.companyId,
      url: source.url,
      finalUrl: source.url,
      targetUrl: link.url,
      anchorText: link.text,
      httpStatus: confirmedStatus,
      observedAt,
      text,
    };
  } catch (error) {
    if (error instanceof QualificationSiteProblemRetryableError) throw error;
    if (error instanceof Error) {
      const cause = (error as Error & { cause?: unknown }).cause;
      const message = `${error.message} ${cause instanceof Error ? cause.message : String(cause ?? "")}`;
      if (
        (error.name === "AbortError" ||
          error.name === "TimeoutError" ||
          error instanceof TypeError) &&
        !/redirect|invalid url|unsupported protocol/i.test(message)
      )
        throw new QualificationSiteProblemRetryableError();
    }
    return undefined;
  }
}
