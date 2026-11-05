export function isCompanyContextEvidence(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  const raw =
    source.raw && typeof source.raw === "object"
      ? (source.raw as Record<string, unknown>)
      : undefined;
  return [source, raw].some(
    (item) =>
      item?.evidenceKind === "employer_event" ||
      item?.contentType === "employer_event" ||
      item?.evidenceKind === "observed_site_problem" ||
      item?.contentType === "observed_site_problem" ||
      [item?.sourceId, item?.id].some(
        (id) =>
          typeof id === "string" &&
          (id.startsWith("employer:") || id.startsWith("site_problem:"))
      )
  );
}
