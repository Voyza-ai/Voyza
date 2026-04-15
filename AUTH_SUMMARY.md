# Voyza Auth — Implementation Summary

## What was built

### Auth pages (frontend/app/auth/)
- **Login** (`/auth/login`) — Email/password sign in, show/hide toggle, error states, redirect logic (to /results if trip exists, /history otherwise)
- **Signup** (`/auth/signup`) — Full name + email + password with strength indicator (weak/medium/strong), confirm password validation
- **Forgot password** (`/auth/forgot-password`) — Reset email flow with success confirmation
- **Callback** (`/auth/callback`) — Handles Supabase email confirmation and password reset redirects via `exchangeCodeForSession`

### Auth state management
- **authStore** (`frontend/store/authStore.ts`) — Zustand store with `user`, `session`, `isLoading`, `signOut()`
- **AuthProvider** (`frontend/components/shared/AuthProvider.tsx`) — Wraps the app in `layout.tsx`, initializes session on mount, subscribes to `onAuthStateChange`
- **supabase.ts** updated — `getCurrentUser()` and `getAuthHeader()` read from authStore first (faster), fall back to Supabase client

### Navbar
- **Logged out**: "Log in" (white pill, blue border) + "Sign up" (solid blue) buttons
- **Logged in**: Avatar circle with initials, dropdown with email, "My Trips", divider, "Sign out"

### Protected routes
- **ProtectedRoute** component — spinner while loading, redirect to `/auth/login?redirect=...` if not authenticated
- Applied to: `/history`, `/canvas/[tripId]`

### Save trip login wall
- **Save trip button** on results page header (blue, bookmark icon)
- If not logged in: opens LoginModal, saves trip after successful login
- If logged in: saves directly via `POST /api/trips`
- Toast notifications for success/error

### LoginModal
- Full rewrite from dark-theme stub to light-theme modal
- Email + password with show/hide, error states
- `onSuccess` callback for post-login actions (e.g. auto-save trip)

### Backend auth middleware
- **requireAuth** (`backend/src/middleware/auth.ts`) — Validates JWT via `supabaseAdmin.auth.getUser(token)`
- Applied to: `/api/trips/*`, `/api/canvas/*`
- NOT applied to: search endpoints (flights, hotels, trains), plan interpret/suggest, health

### Trip CRUD routes (`backend/src/routes/trips.ts`)
- `POST /api/trips` — Creates trip + cities + transports + owner group_member
- `GET /api/trips` — Lists user's non-archived trips with city names and date ranges
- `GET /api/trips/:id` — Full trip with cities and transports (ownership/membership check)
- `DELETE /api/trips/:id` — Soft-delete (sets status to 'archived')

### History page
- Protected route, fetches trips from `GET /api/trips`
- Responsive card grid with gradient headers, status badges, city count, cost
- Skeleton loading state, empty state with "Start planning" CTA
- Delete with fade (archive, not hard delete)

### Tests
- **126 frontend tests** across 15 suites (auth pages, authStore, navbar, protectedRoute, loginModal, + all existing tests)
- **30 backend tests** across 7 suites (requireAuth middleware + existing tests)

---

## Supabase dashboard steps (developer must complete)

1. **Enable email/password auth**
   - Go to Authentication > Providers > Email
   - Ensure "Enable Email provider" is ON
   - Optionally disable "Confirm email" for easier local testing

2. **Set Site URL**
   - Go to Authentication > URL Configuration
   - Site URL: `http://localhost:3000`

3. **Add redirect URLs**
   - In the same URL Configuration section
   - Add: `http://localhost:3000/auth/callback`
   - For production, add your production URL too

4. **Verify environment variables**
   - `frontend/.env.local`:
     ```
     NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
     NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
     NEXT_PUBLIC_API_URL=http://localhost:4000
     ```
   - `backend/.env`:
     ```
     SUPABASE_URL=https://your-project.supabase.co
     SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
     ```

---

## How to test the full auth flow locally

1. Start backend: `cd backend && npm run dev`
2. Start frontend: `cd frontend && npm run dev`
3. Go to `http://localhost:3000/auth/signup` — create an account
4. You'll be redirected to `/history` (empty state)
5. Go to `/plan`, plan a trip, click "Find my trip"
6. On the results page, click "Save trip" — should save directly (you're logged in)
7. Go to `/history` — your saved trip should appear
8. Click the avatar in the navbar > "Sign out"
9. Plan another trip, click "Save trip" — the login modal should appear
10. Sign in through the modal — trip saves automatically after login

---

## Known limitations

- **No social login** — Google button is present but disabled ("Coming soon")
- **No email verification enforcement** — disable "Confirm email" in Supabase for local dev
- **Password reset** requires Supabase email templates to be configured
- **No profile page** — user can't change name/email/password after signup yet
- **Trip GET by ID** reconstructs from DB columns, not the exact Zustand shape — the results page may need mapping logic for full round-trip fidelity
