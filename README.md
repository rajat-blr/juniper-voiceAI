# Juniper — Voice Appointment Receptionist

[Open the live demo](https://juniper-voice-ai.vercel.app)

Run `npm install` and `npm run dev`, then open http://127.0.0.1:5173.
Use **Sign up** to create an account with a username and password, or **Log in** for an existing account.
Usernames are case-insensitive, 3–32 letters/numbers/underscores. Passwords are 8–128 characters.
Accounts and salted scrypt password hashes are stored in PostgreSQL (local development uses persistent PGlite in `.data/booking`). Login uses a seven-day HttpOnly cookie; logout revokes that login and its booking sessions. Booking references remain the way to look up and move an appointment.

Local schema changes apply automatically on API startup. Vercel production builds apply the database migration before building. For other hosting, run `npm run db:migrate` with its `DATABASE_URL` before deploying. Production cookies require HTTPS. `npm run check` builds the app and runs the test suite.
