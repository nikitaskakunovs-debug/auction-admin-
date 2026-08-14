/** Thumbnail sibling of a web-size photo URL (server stores both, -web/-thumb).
 * Foreign/legacy URLs pass through unchanged. */
export const photoThumb = (url: string): string =>
  url.includes("-web.webp") ? url.replace("-web.webp", "-thumb.webp") : url;

/** Веб-размер фото. Значения в items.photos уже web-размер — оставляем как есть,
 *  но если пришёл thumb, поднимаем до web. */
export const photoWeb = (url: string): string =>
  url.includes("-thumb.webp") ? url.replace("-thumb.webp", "-web.webp") : url;
