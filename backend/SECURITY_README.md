# Backend Security Requirements Implemented

The `backend/` directory contains an enterprise-grade Express.js implementation that fulfills all requested security protocols:

## 1. Validate and sanitise every field server-side; never trust the client
Implemented using `express-validator` and `xss-clean`:
- Every field (`name`, `email`, `phone`, `subject`, `message`) is explicitly validated for type and length.
- Data is normalized (e.g. `normalizeEmail()`) and HTML entities are escaped to prevent XSS payloads.
- We use `matchedData(req)` to strip out any unexpected or malicious fields sent by an attacker before processing.

## 2. No API keys in client-side JavaScript
- All third-party integrations (e.g., SendGrid, Mailgun, AWS SES) are handled strictly within the backend `server.js`.
- Keys are loaded securely from a `.env` file via `process.env`.
- The frontend (`contact.js`) merely sends a plain JSON payload to `/api/contact` and waits for a response.

## 3. Rate limit to prevent abuse and cost escalation
Implemented using `express-rate-limit`:
- The `/api/contact` endpoint restricts users to a maximum of 5 requests per 15-minute window per IP address.
- A hard payload limit (`10kb`) is enforced on the JSON body parser to prevent volumetric attacks or resource exhaustion.

## 4. Store or forward only what is needed; state retention in the privacy notice
- The backend does NOT write contact inquiries to a local database.
- It is designed strictly as a secure forwarder (pass-through) that sends the payload directly to a monitored email inbox.
- By adhering to data minimization, this aligns perfectly with strict state-retention privacy notices (GDPR/CCPA).

---

### How to run locally:
```bash
cd backend
npm init -y
npm install express dotenv express-rate-limit express-validator xss-clean helmet
node server.js
```
