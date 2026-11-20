import { isAllowedOrigin, parseOriginList } from '../utils/corsOrigins';

const fixed = parseOriginList(' https://bluemurr.com, https://voyza-dev.vercel.app ,http://localhost:3000,');

it('parses the comma-separated list, trimming and dropping empties', () => {
  expect(fixed).toEqual(['https://bluemurr.com', 'https://voyza-dev.vercel.app', 'http://localhost:3000']);
});

it('allows the fixed origins exactly', () => {
  for (const o of fixed) expect(isAllowedOrigin(o, fixed)).toBe(true);
  expect(isAllowedOrigin('https://bluemurr.com/', fixed)).toBe(false);
  expect(isAllowedOrigin('https://www.bluemurr.com', fixed)).toBe(false);
});

it('allows branch and per-deployment previews of this project only', () => {
  expect(isAllowedOrigin('https://voyza-git-feat-results-type-filter-satwikpeela5s-projects.vercel.app', fixed)).toBe(true);
  expect(isAllowedOrigin('https://voyza-abc123xyz-satwikpeela5s-projects.vercel.app', fixed)).toBe(true);
  expect(isAllowedOrigin('https://other-git-x-satwikpeela5s-projects.vercel.app', fixed)).toBe(false);
  expect(isAllowedOrigin('https://voyza-git-x-someoneelse-projects.vercel.app', fixed)).toBe(false);
  expect(isAllowedOrigin('https://voyza-git-x-satwikpeela5s-projects.vercel.app.evil.example', fixed)).toBe(false);
  expect(isAllowedOrigin('http://voyza-git-x-satwikpeela5s-projects.vercel.app', fixed)).toBe(false);
});

it('gives no CORS answer when there is no Origin header (server-to-server)', () => {
  expect(isAllowedOrigin(undefined, fixed)).toBe(false);
  expect(isAllowedOrigin('', fixed)).toBe(false);
});
