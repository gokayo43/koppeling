/**
 * Where the API is, for every client in this app — the Eden client and the auth
 * client both read it, so the two cannot disagree about which program they are
 * talking to. Nothing else about them agrees by itself — `api-client.ts` says
 * what the Eden one has to be told before its calls carry the session.
 *
 * The fallback is dev's answer, and dev has no other: `VITE_API_URL` is set by
 * the web image's build — out of the `PUBLIC_API_URL` in whichever origins file
 * compose named it, `deploy.env` or the one `scripts/preview.sh` writes — and
 * by `scripts/worktree.ts`, from the API port it claimed for this worktree. A
 * checkout's `.env` carries a `PUBLIC_API_URL` of its own, which the API reads
 * to know where it answers, and `.env.example` writes it to match this line.
 *
 * Deployed, that value is the API's own hostname — `api.<site>`, the second
 * server block in `infra/nginx/`, whose comment holds the reason it is not a
 * path under the site's name instead.
 *
 * That the deploy's value is the one with the odd name is the whole design:
 * vite inlines every VITE_-prefixed value it can see, `.env` included, so an
 * origin written under that prefix in a file a checkout loads is an origin a
 * developer's browser calls. One key cannot hold both answers, so they have
 * different names — and the VITE_ one exists for a single command inside
 * `Dockerfile.web`, where no checkout can reach it.
 */
export const apiUrl = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3001";
