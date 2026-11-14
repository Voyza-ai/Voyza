/**
 * Which browser origins may call the API.
 *
 * `CORS_ORIGIN` (comma-separated) lists the fixed ones: production, the
 * `dev` preview alias, localhost. On top of that, every Vercel preview of
 * OUR frontend project is allowed, so each feature branch gets a working
 * preview link (https://voyza-git-<branch>-satwikpeela5s-projects.vercel.app)
 * the owner can open before anything is merged. Before this, a branch
 * preview loaded but every API call failed CORS, so features could only be
 * tried after merging into `dev`.
 *
 * Only hosts under the team scope `satwikpeela5s-projects.vercel.app` match.
 * Vercel issues those names only to deployments of this team's projects, so
 * nobody outside the team can mint a matching origin. The pattern is
 * anchored at both ends and allows only [a-z0-9-] in the variable part, so
 * look-alikes (another team's scope, an extra suffix, http, a port, a path)
 * do not match.
 */
const VERCEL_PREVIEW_ORIGIN = /^https:\/\/voyza-[a-z0-9-]+-satwikpeela5s-projects\.vercel\.app$/;

export function parseOriginList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(origin: string | undefined, fixed: readonly string[]): boolean {
  if (!origin) return false;
  return fixed.includes(origin) || VERCEL_PREVIEW_ORIGIN.test(origin);
}
