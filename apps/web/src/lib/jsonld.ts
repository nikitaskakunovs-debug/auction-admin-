/**
 * Escape a JSON string for safe embedding inside a <script> element.
 * JSON.stringify does NOT escape "<", ">" or "&", so a "</script>" sequence in
 * any embedded (admin-entered) value would break out of the element. Also
 * escape U+2028/U+2029, which are valid JSON but illegal raw in JS string
 * literals. Every HTML-significant char becomes a \uXXXX escape.
 */
export function jsonLdScript(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
