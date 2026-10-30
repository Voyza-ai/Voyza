/**
 * D-17: leftover stub routes are gone.
 *
 * `/group/<id>` ("Group Workspace … Coming in Phase 6") and `/trip/<id>`
 * ("Trip Details … Coming in Phase 4") were public placeholder pages, and the
 * Next API routes `/api/trips` (GET `{"trips":[]}`, POST echoing
 * `{"success":true}` without saving) and `/api/optimize` (POST echoing
 * `{"success":true,"savings":0}`) answered as if they worked. Nothing links to
 * or calls any of them: the app's trips and optimize calls all go to the
 * backend (`NEXT_PUBLIC_API_URL`), and the backend's emails and share links
 * point at /main and /canvas/<id>. Harness 2026-10-30: all four answered 200.
 *
 * This walks the source the way Next builds routes, so it also fails if one
 * comes back under another file name (route.js, page.jsx …).
 */
import fs from 'node:fs';
import path from 'node:path';

const APP = path.join(__dirname, '..', '..', 'app');

function routeFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? routeFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    .filter((f) => /\/(page|route)\.(t|j)sx?$/.test(f));
}

describe('stub routes', () => {
  it.each([
    ['/group/<id>', 'group'],
    ['/trip/<id>', 'trip'],
    ['Next /api/trips', 'api/trips'],
    ['Next /api/optimize', 'api/optimize'],
  ])('%s has no page or route handler', (_label, dir) => {
    expect(routeFiles(path.join(APP, dir))).toEqual([]);
  });

  it('the app never calls a relative /api/trips or /api/optimize (they go to the backend)', () => {
    const roots = ['app', 'components', 'lib', 'store', 'hooks'].map((d) => path.join(__dirname, '..', '..', d));
    const offenders: string[] = [];
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(t|j)sx?$/.test(e.name)) {
          const src = fs.readFileSync(p, 'utf8');
          // fetch('/api/trips…') or fetch(`/api/optimize`) — a same-origin call.
          if (/fetch\(\s*['"`]\/api\/(trips|optimize)/.test(src)) offenders.push(p);
          if (/href=\{?\s*['"`]\/(group|trip)\//.test(src)) offenders.push(p);
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});
