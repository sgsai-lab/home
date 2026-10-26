# Runbook: Firestore and Cloud Storage

## Health

- `GET /api/readyz` returns `{"status":"ok","database":"firestore"}`, or `503` when Firestore is unreachable. Cloud Run logs carry `request_id` on every failed API request.
- Production sets `ALLOW_MEMORY_DB_FALLBACK=false` in the image, so a Firestore outage returns `503 SERVICE_UNAVAILABLE` instead of silently using per-instance memory. Never enable the fallback in production: sessions would differ between instances.

## TTL, indexes, rules, backups

Managed by Terraform in the `infrastructure` repository (INF-13). Apply indexes before deploying code that depends on them. For a manual check:

```sh
gcloud firestore fields ttls list --project home-509818
gcloud firestore indexes composite list --project home-509818
gcloud firestore backups list --location <region> --project home-509818
```

TTL fields are `expire_at` on: `sessions`, `refresh_tokens`, `user_sessions`, `email_verifications`, `password_resets`, `mfa_challenges`, `launch_tokens`, `invites`, `projects` (soft-deleted only), `assets` (pending only), `launch_events`, `audit_log`. TTL deletion runs within about 24 hours of expiry.

### Restore

1. Restore the daily backup into a scratch database: `gcloud firestore databases restore --source-backup=<backup> --destination-database=restore-<date>`.
2. Export the needed collections from the scratch database and import them into `(default)`, or point a staging revision at it with `FIRESTORE_DATABASE`.
3. Delete the scratch database afterwards.

## Cloud Storage

- Buckets (INF-12): `sgsai-media-{env}` (private, uniform access, versioning, public access prevention enforced) and `sgsai-public-assets-{env}` (public read, icons only).
- The Cloud Run runtime service account signs URLs through IAM `signBlob`; it needs `roles/storage.objectAdmin` on both buckets and `roles/iam.serviceAccountTokenCreator` on itself. No key files.
- CORS on the media bucket must allow `PUT, GET, HEAD` from the site origins with headers `Content-Type, x-goog-content-length-range`. Upload failures with status 0 in the browser are usually CORS.
- The CSP allows `https://storage.googleapis.com` for `connect-src`, `img-src` and `media-src` only.
- Pending uploads: lifecycle deletes unconfirmed objects; their Firestore records expire after 24 hours.

## Common incidents

| Symptom | Check |
| --- | --- |
| All API calls `503` | `/api/readyz`; Firestore status page; runtime service account still has `roles/datastore.user` |
| Uploads fail in the browser | Bucket CORS; `MEDIA_BUCKET` set; CSP `connect-src` |
| Images do not load | Signed URLs expire after 1 hour; the page re-requests them on reload |
| Public icon missing on `/products/` | `PUBLIC_ASSETS_BUCKET` set; product is `public` and not `retired`; icon confirmed |
| Users signed out unexpectedly | A refresh token was reused (logged as `Refresh token reuse detected`), password reset, or account disabled |
