import { assetNumberSchema } from '@open-itsm/shared';

/** The address a printed tag's QR code holds: short, and readable by any phone camera. */
export function tagUrl(origin: string, number: string): string {
  return `${origin}/a/${encodeURIComponent(number)}`;
}

/**
 * The asset number in what a camera or a keyboard-mode scanner read: a tag URL from
 * {@link tagUrl} (any host, so tags survive a change of address) or a typed asset number.
 * Returns null for anything else, such as another site's QR code.
 */
export function parseScan(text: string): string | null {
  const value = text.trim();
  if (/^https?:\/\//i.test(value)) {
    let path: string;
    try {
      path = new URL(value).pathname;
    } catch {
      return null;
    }
    const match = /^\/a\/(.+)$/.exec(path);
    if (!match?.[1]) return null;
    let number: string;
    try {
      number = decodeURIComponent(match[1]);
    } catch {
      return null;
    }
    return assetNumberSchema.safeParse(number).success ? number : null;
  }
  return assetNumberSchema.safeParse(value).success ? value : null;
}
