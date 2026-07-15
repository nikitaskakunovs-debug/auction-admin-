/** Thumbnail sibling of a web-size photo URL (server stores both, -web/-thumb).
 * Foreign/legacy URLs pass through unchanged. */
export const photoThumb = (url: string): string =>
  url.includes("-web.webp") ? url.replace("-web.webp", "-thumb.webp") : url;
