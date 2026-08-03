# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately via [GitHub Security Advisories](https://github.com/neosun100/edgetts-ws-worker/security/advisories/new),
or contact the maintainer directly. You'll get an acknowledgement within a few days.

## Scope & design notes

This is a thin proxy in front of Microsoft's Edge/Azure TTS. A few things are
**intentional design choices**, not vulnerabilities:

- **Open CORS (`Access-Control-Allow-Origin: *`)** — the service is meant to be
  callable from any frontend. This is deliberate.
- **No rate limiting** — access is gated only by the `API_KEY` bearer token; there
  is no per-key throttling. Also deliberate. If you run your own instance and want
  limits, put Cloudflare Rate Limiting in front.

Genuinely in scope:

- Auth bypass (serving synthesis without a valid key when `API_KEY` is set)
- SSML/header injection through request parameters
- Secrets leaking into logs or responses
- Any way to make the Worker fetch or return arbitrary third-party content

## Running securely

- Always bind an `API_KEY` secret (`wrangler secret put API_KEY`). Without it the
  Worker returns **503** rather than serving unauthenticated traffic — unless you
  explicitly set `ALLOW_ANONYMOUS=true`.
- Never commit `.env`, tokens, or the `API_KEY` value.
