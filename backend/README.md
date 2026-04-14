# Voyza Backend

Express + TypeScript API server for Voyza. Handles everything the frontend shouldn't touch directly — secret API keys, external provider calls (Duffel, Kiwi, Stripe), Supabase admin operations, and Claude-powered planning logic.

## Stack

- **Express 4** — HTTP server
- **TypeScript** — strict mode, compiled to `dist/`
- **Zod** — request + env validation
- **Helmet + CORS + Morgan** — security and logging middleware
- **@supabase/supabase-js** — admin-level DB access (service role key)
- **@anthropic-ai/sdk** — Claude calls
- **@duffel/api** — flight search/booking
- **tsx** — dev hot reload

## Folder structure

```
backend/
├── src/
│   ├── config/
│   │   └── env.ts               # Zod-validated environment, single source of truth
│   ├── middleware/
│   │   ├── asyncHandler.ts      # Wraps async handlers so thrown errors reach error middleware
│   │   └── error.ts             # AppError class + global error + 404 handlers
│   ├── routes/
│   │   ├── index.ts             # Mounts all routers under /api
│   │   ├── health.ts            # GET /api/health
│   │   ├── flights.ts           # POST /api/flights/search (stub)
│   │   └── ai.ts                # POST /api/ai/chat (Claude passthrough)
│   ├── services/
│   │   ├── supabase.ts          # Lazy service-role client
│   │   ├── anthropic.ts         # Lazy Anthropic client + DEFAULT_MODEL
│   │   └── duffel.ts            # Lazy Duffel client (throws 503 if not configured)
│   ├── utils/
│   │   └── logger.ts            # JSON structured logger
│   └── index.ts                 # Entry: middleware, routes, graceful shutdown
├── .env                         # Local secrets (gitignored)
├── .env.example                 # Committed template
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

## Getting started

```bash
cd backend
npm install
cp .env.example .env   # then fill in real values
npm run dev
```

The server starts on `http://localhost:4000`. Try:

```bash
curl http://localhost:4000/api/health
```

## Environment variables

All env vars are validated at startup. If any are missing or malformed, the process exits with a descriptive error.

| Variable                      | Required | Purpose                                               |
| ----------------------------- | -------- | ----------------------------------------------------- |
| `PORT`                        | no       | Defaults to `4000`                                    |
| `NODE_ENV`                    | no       | `development` / `production` / `test`                 |
| `CORS_ORIGIN`                 | no       | Comma-separated allowed origins                       |
| `SUPABASE_URL`                | **yes**  | Supabase project URL                                  |
| `SUPABASE_SERVICE_ROLE_KEY`   | **yes**  | Bypasses RLS — server only, never expose              |
| `ANTHROPIC_API_KEY`           | **yes**  | Claude API                                            |
| `DUFFEL_ACCESS_TOKEN`         | no       | Required once flight routes are wired up              |

## Scripts

| Command           | What it does                                          |
| ----------------- | ----------------------------------------------------- |
| `npm run dev`     | Hot-reload dev server via `tsx watch`                 |
| `npm run build`   | Compile TS to `dist/`                                 |
| `npm run start`   | Run compiled build                                    |
| `npm run typecheck` | `tsc --noEmit`                                      |

## Adding a new route

1. Create `src/routes/your-feature.ts` with a `Router` export.
2. Use `asyncHandler` around async handlers and `zod` to validate `req.body`.
3. Mount it in `src/routes/index.ts` under `/api/your-feature`.

Example skeleton:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';

const router = Router();
const schema = z.object({ foo: z.string() });

router.post('/', asyncHandler(async (req, res) => {
  const { foo } = schema.parse(req.body);
  res.json({ echoed: foo });
}));

export default router;
```

## Wiring the Next.js frontend

In the frontend (`voyza/`), add:

```
# voyza/.env.local
NEXT_PUBLIC_API_URL=http://localhost:4000
```

Then call backend routes from Next.js code via `fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/...`)`.

Keep `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, and any provider tokens out of `voyza/.env.local` — they belong only in `backend/.env`.
