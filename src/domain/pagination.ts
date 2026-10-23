/**
 * Page-window arithmetic, kept pure so it can be property-tested without a
 * database. `page` is 1-based and `size` is clamped into [MIN_SIZE, MAX_SIZE];
 * any out-of-range request is answered with the nearest legal window rather
 * than an error, because a caller asking for page 0 wants the first page.
 */
export const MIN_SIZE = 1;
export const MAX_SIZE = 100;

export interface PageWindow {
  readonly limit: number;
  readonly offset: number;
}

export function pageWindow(page: number, size: number): PageWindow {
  const limit = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.trunc(size)));
  const index = Math.max(1, Math.trunc(page)) - 1;
  return { limit, offset: index * limit };
}

export function pageCount(total: number, size: number): number {
  const limit = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.trunc(size)));
  return Math.max(1, Math.ceil(Math.max(0, Math.trunc(total)) / limit));
}
