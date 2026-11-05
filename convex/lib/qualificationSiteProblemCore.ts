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
  officialWebsite: string
): { url: string; text: string } | undefined {
  // shortcut: pages using <base> or ambiguous attributes are skipped until a full DOM reader is needed.
  if (/<base\b/i.test(html)) return undefined;
  const body =
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    html;
  const content = body
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
  for (const anchor of content.matchAll(
    /<a\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a>/gi
  )) {
    const attributes = htmlAttributes(anchor[1]);
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
      !COMMERCIAL_OR_DOC_ROUTE.test(new URL(target).pathname)
    )
      continue;
    const text = anchor[2]
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
