import Exa from "exa-js";
import { isPublicHttpUrl } from "../utils/url/urlSafety";

export type DescribeUrlResult =
  | {
      success: true;
      content: string;
      title?: string;
      author?: string;
      finalUrl?: string;
      publishedDate?: string;
      source: "exa" | "html-fallback";
    }
  | {
      success: false;
      error: string;
    };

const MIN_CONTENT_LENGTH = 50;
const MAX_CONTENT_CHARS = 8000;
const REQUEST_TIMEOUT_MS = 12000;

function createExaClient(): Exa | null {
  const apiKey = process.env.EXA_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  return new Exa(apiKey);
}

function decodeHtmlEntities(value: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
  };

  return value.replace(/&[a-zA-Z0-9#]+;/g, (entity) => entities[entity] ?? " ");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractTagText(html: string, tagName: string): string | undefined {
  const match = html.match(
    new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i")
  );
  const text = match?.[1]
    ? collapseWhitespace(decodeHtmlEntities(match[1]))
    : "";
  return text || undefined;
}

function extractMetaContent(html: string, key: string): string | undefined {
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:name|property)=["']${key}["'][^>]+content=["']([^"']+)["']`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${key}["']`,
      "i"
    ),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const text = collapseWhitespace(decodeHtmlEntities(match[1]));
      if (text) {
        return text;
      }
    }
  }

  return undefined;
}

function htmlToPlainText(html: string): string {
  const withoutNoise = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ");

  const withBreaks = withoutNoise
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");

  const text = withBreaks
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/gi, " ");

  return collapseWhitespace(decodeHtmlEntities(text));
}

function truncateContent(value: string): string {
  return value.length > MAX_CONTENT_CHARS
    ? value.slice(0, MAX_CONTENT_CHARS)
    : value;
}

/** Accept only this page's publisher metadata, never crawl dates or related articles. */
function publisherPublicationDate(
  html: string,
  pageUrl: string
): string | undefined {
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? "";
  const canonical = head.match(
    /<link\b(?=[^>]*\brel=["']canonical["'])(?=[^>]*\bhref=["']([^"']+)["'])[^>]*>/i
  )?.[1];
  const samePage = (value: unknown) => {
    if (typeof value !== "string") return false;
    try {
      const candidate = new URL(value, pageUrl);
      const page = new URL(pageUrl);
      candidate.hash = page.hash = "";
      return candidate.href.replace(/\/$/, "") === page.href.replace(/\/$/, "");
    } catch {
      return false;
    }
  };
  if (canonical && !samePage(decodeHtmlEntities(canonical))) return undefined;
  const explicit =
    extractMetaContent(head, "article:published_time") ??
    extractMetaContent(head, "parsely-pub-date");
  if (explicit) return explicit;
  const dates = new Set<string>();
  const inspect = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    if (!value || typeof value !== "object") return;
    const entry = value as Record<string, unknown>;
    if (Array.isArray(entry["@graph"])) entry["@graph"].forEach(inspect);
    const types = Array.isArray(entry["@type"])
      ? entry["@type"]
      : [entry["@type"]];
    const main = entry.mainEntityOfPage;
    const identity =
      entry.url ??
      (main && typeof main === "object"
        ? (main as Record<string, unknown>)["@id"]
        : main);
    if (
      types.some((type) =>
        ["Article", "NewsArticle", "BlogPosting", "TechArticle"].includes(
          String(type)
        )
      ) &&
      samePage(identity) &&
      typeof entry.datePublished === "string"
    )
      dates.add(entry.datePublished);
  };
  for (const script of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      inspect(JSON.parse(script[1]));
    } catch {
      /* Invalid metadata is not publication proof. */
    }
  }
  return dates.size === 1 ? [...dates][0] : undefined;
}

async function tryDescribeWithExa(
  url: string
): Promise<DescribeUrlResult | null> {
  const exa = createExaClient();
  if (!exa) {
    return null;
  }

  try {
    const result = await exa.getContents([url], {
      text: true,
      livecrawl: "preferred",
    });

    const page = result.results?.[0];
    const text = page?.text ? collapseWhitespace(page.text) : "";
    if (text.length < MIN_CONTENT_LENGTH) {
      return null;
    }

    return {
      success: true,
      content: truncateContent(text),
      title: page?.title?.trim() || undefined,
      author: page?.author?.trim() || undefined,
      finalUrl: page?.url,
      publishedDate: page?.publishedDate ?? undefined,
      source: "exa",
    };
  } catch {
    return null;
  }
}

async function tryDescribeWithHtmlFetch(
  url: string,
  rejectRedirects = false
): Promise<DescribeUrlResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: rejectRedirects ? "error" : "follow",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Website returned HTTP ${response.status}`,
      };
    }

    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? "";
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml") &&
      !contentType.includes("text/plain")
    ) {
      return {
        success: false,
        error: `Unsupported content type: ${contentType || "unknown"}`,
      };
    }

    const raw = await response.text();
    const title =
      extractMetaContent(raw, "og:title") ?? extractTagText(raw, "title");
    const description =
      extractMetaContent(raw, "description") ??
      extractMetaContent(raw, "og:description") ??
      extractMetaContent(raw, "twitter:description");
    const author =
      extractMetaContent(raw, "author") ??
      extractMetaContent(raw, "article:author") ??
      extractMetaContent(raw, "parsely-author");
    const bodyText = htmlToPlainText(raw);
    const combined = collapseWhitespace(
      [title, description, bodyText].filter(Boolean).join("\n\n")
    );

    if (combined.length < MIN_CONTENT_LENGTH) {
      return {
        success: false,
        error: "Could not extract sufficient content from URL",
      };
    }

    return {
      success: true,
      content: truncateContent(combined),
      title,
      author,
      finalUrl: response.url,
      publishedDate: publisherPublicationDate(raw, response.url || url),
      source: "html-fallback",
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        success: false,
        error: `Website timed out after ${REQUEST_TIMEOUT_MS}ms`,
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "Network error",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export function validateDescribeUrlInput(input: string):
  | { ok: true; url: string }
  | {
      ok: false;
      error: string;
    } {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: "Invalid URL format" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only HTTP and HTTPS URLs are supported" };
  }

  if (!isPublicHttpUrl(parsed.href) || parsed.username || parsed.password) {
    return {
      ok: false,
      error: "Local and private-network URLs are not supported",
    };
  }

  return { ok: true, url: parsed.toString() };
}

export async function describeUrl(url: string): Promise<DescribeUrlResult> {
  const validation = validateDescribeUrlInput(url);
  if (!validation.ok) {
    return { success: false, error: validation.error };
  }

  const exaResult = await tryDescribeWithExa(validation.url);
  if (exaResult?.success) {
    return exaResult;
  }

  return tryDescribeWithHtmlFetch(validation.url);
}

/** Direct HTML reader used only after a tracked primary provider attempt. */
export async function describeUrlWithHtmlFallback(
  url: string,
  options?: { rejectRedirects?: boolean }
): Promise<DescribeUrlResult> {
  const validation = validateDescribeUrlInput(url);
  if (!validation.ok) {
    return { success: false, error: validation.error };
  }

  return tryDescribeWithHtmlFetch(validation.url, options?.rejectRedirects);
}
