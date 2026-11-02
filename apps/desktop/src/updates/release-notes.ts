/**
 * Adapted from T3 Code apps/desktop/src/updates/releaseNotes.ts,
 * 70cd258d8aac43ea57494527b00bf36de3efa6c0.
 * Divergences: GitGui displays bounded plain text instead of normalized release
 * groups; it keeps at most six notes and bounds input/output size. Numeric
 * entities yielding surrogate code points are retained literally because they
 * are not Unicode scalar values; own-property lookup preserves unknown named
 * entities, and control stripping runs after decoding to cover encoded controls.
 */

const HTML_ENTITY_REPLACEMENTS: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function decodeCodePoint(codePoint: number, entity: string): string {
  // Keep malformed and non-scalar numeric references intact instead of throwing.
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return `&${entity};`;
  }
  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntity(entity: string): string {
  if (Object.prototype.hasOwnProperty.call(HTML_ENTITY_REPLACEMENTS, entity)) {
    return HTML_ENTITY_REPLACEMENTS[entity]!;
  }
  if (entity.startsWith("#x")) {
    return decodeCodePoint(Number.parseInt(entity.slice(2), 16), entity);
  }
  if (entity.startsWith("#")) {
    return decodeCodePoint(Number.parseInt(entity.slice(1), 10), entity);
  }
  return `&${entity};`;
}

function decodeHtmlEntities(input: string): string {
  return input.replace(/&([a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, (_match, entity: string) =>
    decodeHtmlEntity(entity),
  );
}

/** Convert updater release notes to bounded, markup-free text for the UI. */
export function releaseNotesText(value: unknown): string {
  const notes = typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.slice(0, 6).map((entry: unknown) => typeof entry === "object" && entry !== null
        && "note" in entry && typeof entry.note === "string" ? entry.note : "").join("\n\n")
      : "";

  const plainText = notes.slice(0, 32_000)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "");

  // Decode after markup removal so decoded angle brackets remain literal text.
  return decodeHtmlEntities(plainText)
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim().slice(0, 8_000);
}
