/**
 * Where the web app lives, asked of the tree rather than declared: the monorepo
 * keeps it under `apps/web` and the single-app repo keeps it at the root, while
 * the scripts beside this file are the same files in both — so the ones that
 * read the web app have to find it first.
 */

/** The repo, whichever checkout it is: this module's own directory is `scripts/`. */
const ROOT = new URL("..", import.meta.url);

/** The monorepo's copy of a repo-relative path if there is one, the single app's otherwise. */
export async function webPath(monorepo: string, single: string): Promise<string> {
  const path = new URL(monorepo, ROOT).pathname;
  return (await Bun.file(path).exists()) ? path : new URL(single, ROOT).pathname;
}
