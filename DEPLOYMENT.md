# Production deployment

The Vite frontend and Fastify API deploy to Vercel. Neon stores booking state, idempotent operations, usage counts, and encrypted one-use voice handoffs. The Python receptionist deploys to LiveKit Cloud, where it can remain connected between HTTP requests.

## Secrets

Run `node --import tsx tools/prepare-production.ts` to prepare ignored `.env.production.local` with owner-only permissions. This copies only the three LiveKit credentials from local `.env` and generates a separate production shared secret. Set the Neon pooled `DATABASE_URL` and the final `BOOKING_API_URL` locally. Never commit these files or use `VITE_` prefixes for credentials.

Vercel needs `DATABASE_URL`, `AGENT_SHARED_SECRET`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` in its **Production** environment. Store credential values as sensitive variables. Upload values through the dashboard or `vercel env add NAME production --sensitive` using standard input, never command arguments. Preview deployments disable voice, even if `VOICE_ENABLED=true`.

Set `VOICE_ENABLED=false` until the API database and cloud worker are ready. Defaults allow five voice connections per UTC day, twenty per calendar month, and five per session per hour. Each conversation ends after five minutes. These application limits do not measure remaining provider credits; keep the LiveKit project on Build and monitor its dashboard.

## Database and Vercel

1. Import `rajat-blr/juniper-voiceAI` into Vercel, using the repository root. `vercel.json` supplies build, output, routing, and Singapore function region settings.
2. Create a Neon **Free** database in Singapore through Vercel Storage. Disable unused Neon Auth. Connect it only to this project's production environment. Use the pooled PostgreSQL connection string as `DATABASE_URL`; keep TLS enabled.
3. Save production variables. Set the same production `AGENT_SHARED_SECRET` on both services.
4. Vercel production builds run `npm run db:migrate` before building the app, using the production `DATABASE_URL`. The schema migration is idempotent and adds authentication tables without removing existing bookings. Preview builds and production requests do not run migrations. For other hosting, run the migration before deploying. Do not reuse the local `.data/booking` files in deployment.
5. Deploy Vercel. Verify `/api/health` and the manual booking, lookup, refresh, and rescheduling flows before enabling voice.

## LiveKit Cloud

`apps/agent/Dockerfile` packages the Python worker and pinned direct dependencies. Its `.dockerignore` excludes credentials, local database files, and development environments. The container runs as an unprivileged user and predownloads plugin assets. The root Dockerfile also supports `docker build .`, but the LiveKit CLI must use the Python subdirectory to avoid detecting the root JavaScript application.

1. Authenticate the official CLI: `lk cloud auth`. Select the same Build project used by Vercel's LiveKit credentials.
2. Set `BOOKING_API_URL=https://YOUR-PRODUCTION-DOMAIN/api` in `.env.production.local`. Run `node --import tsx tools/prepare-production.ts` again. The ignored `.data/deploy/agent.env` contains only worker settings and the shared secret.
3. From the repository root, run `lk agent create --region ap-south --secrets-file="$PWD/.data/deploy/agent.env" apps/agent`. For later versions, run `lk agent deploy apps/agent`; use `lk agent update-secrets --secrets-file="$PWD/.data/deploy/agent.env" apps/agent` when settings change.
4. Keep the generated `apps/agent/livekit.toml` as deployment metadata. LiveKit injects its own `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`; do not upload development credentials as worker secrets.
5. Check `lk agent status apps/agent`. Enable `VOICE_ENABLED=true` in Vercel production, redeploy, then test greeting, booking confirmation, rescheduling, and interruption on the public site. The browser allows 90 seconds for a cold receptionist to become ready.

Stop the local development worker before testing cloud voice on the same project and agent name. Otherwise either worker may receive the dispatch.

## Prepared local deployment command

This workspace includes ignored official CLI installations and `npm run deploy:production`. Run it from a normal terminal after the Neon connection is saved and the real `BOOKING_API_URL` is set. It uploads allowlisted production settings through stdin, deploys the Vercel API with voice disabled, checks API health, then creates or updates the LiveKit Cloud worker using the private secret file. It preserves voice's disabled state until cloud health is verified. Provider logs remain in owner-only files under `.data/deploy`; inspect failures locally without sharing credentials.

Use `npm run deploy:production -- --check` to validate private settings without network calls. CLI installations and account login are machine-local prerequisites, not committed dependencies.

After the Vercel deployment and API health check have succeeded, `npm run deploy:production -- --agent-only` retries only worker deployment. It does not upload Vercel variables or rebuild that API.

Official guides: [LiveKit agent deployment](https://docs.livekit.io/deploy/agents/), [worker secrets](https://docs.livekit.io/deploy/agents/secrets/), and [Vercel sensitive variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables).
