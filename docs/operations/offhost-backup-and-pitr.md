# Off-host database backups and Neon point-in-time recovery: owner setup

Status 2026-11-21: `BACKUP_S3_URI` is unset in production, so `pg-backup-offhost`
records `OFFHOST_COPY FAILED` every hour. The watchdog now alerts on that
(`BACKUP_OFFHOST_COPY_MISSING`). Every backup exists only on the production host
until the owner completes section 1.

## 1. Off-host destination (minimum setup)

The destination must be separate from the production host, from the evidence
bucket (`proovra-evidence-prod-eu`) and from the evidence credential. The best
option is another AWS account. If that is not possible, use the same account with
its own bucket and its own IAM user.

### 1.1 Bucket

| Setting | Value |
|---|---|
| Name | e.g. `proovra-db-backups-eu` (any name not used for evidence) |
| Region | `eu-central-1` |
| Block Public Access | all four settings ON |
| Object Ownership | Bucket owner enforced (ACLs disabled) |
| Default encryption | SSE-S3 (AES-256). SSE-KMS also works, but the IAM user then also needs `kms:GenerateDataKey` and `kms:Decrypt` on that key |
| Versioning | Enabled |
| Object Lock | **Off.** The pinned `amazon/aws-cli:2.17.0` image sends no Content-MD5 or checksum header on upload, and S3 requires one for objects under Object Lock retention. Versioning plus the lifecycle below, with no delete permission, gives the protection instead |
| Bucket policy | deny requests without TLS (below) |

Lifecycle rule (prefix `postgres/`):
- expire current versions **14 days** after creation;
- permanently delete noncurrent versions **7 days** after they become noncurrent;
- abort incomplete multipart uploads after **2 days**.

Bucket policy (deny plain HTTP):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::proovra-db-backups-eu", "arn:aws:s3:::proovra-db-backups-eu/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
```

### 1.2 Dedicated IAM user and policy

Create a user (e.g. `proovra-db-backup-writer`) with an access key and no console
access. Attach only this policy. It has no `s3:DeleteObject`: the copy script never
deletes, and retention belongs to the lifecycle rule.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListBackupPrefix",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::proovra-db-backups-eu",
      "Condition": { "StringLike": { "s3:prefix": ["postgres/", "postgres/*"] } }
    },
    {
      "Sid": "ReadWriteBackupObjects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::proovra-db-backups-eu/postgres/*"
    }
  ]
}
```

`s3:GetObject` is what `pg-backup-offhost.sh` uses to read back the checksum file
after each upload, and what `pg-backup-offhost-verify.sh` uses to download the dump.

### 1.3 Server env file (`/opt/proovra/app/.env`)

These are the names `infra/docker/docker-compose.prod.yml` already passes to
`pg-backup-offhost`:

| Variable | Value |
|---|---|
| `BACKUP_S3_URI` | `s3://proovra-db-backups-eu/postgres` |
| `BACKUP_AWS_ACCESS_KEY_ID` | the dedicated user's key id |
| `BACKUP_AWS_SECRET_ACCESS_KEY` | its secret |
| `BACKUP_AWS_REGION` | `eu-central-1` (the default) |
| `BACKUP_S3_ENDPOINT_URL` | leave empty for AWS |
| `BACKUP_OFFHOST_INTERVAL_SECONDS` | optional, default 3600 |

Then recreate only the off-host service, so it reads the env file:

```bash
docker compose --env-file /opt/proovra/app/.env -f infra/docker/docker-compose.prod.yml \
  --profile backup up -d --force-recreate --no-deps pg-backup-offhost
docker compose --env-file /opt/proovra/app/.env -f infra/docker/docker-compose.prod.yml \
  --profile backup logs --tail 20 pg-backup-offhost
# expect: pg-backup-offhost: OK proovra-<stamp>.dump copied and verified (4 artifacts, sizes and checksum file match)
```

The next `pg-backup` cycle records `OFFHOST_COPY SUCCEEDED`, and the watchdog then
sends one `Resolved: Off-host backup copy failed`. Then run the proof in
`docs/runbooks/disaster-recovery.md` ("Proving the off-host copy restores").

## 2. Retention policy

| Where | Kept | Set by |
|---|---|---|
| Production host, `/opt/proovra/backups/postgres` | the newest 4 dumps (about 24 h at one dump every 6 h), about 4.3 GB | `BACKUP_RETAIN=4` (compose) |
| Off-host bucket | every dump for 14 days (about 56 dumps, about 60 GB at 1.07 GB each), plus 7 days of noncurrent versions | the bucket lifecycle rule |
| Neon (provider) | point-in-time restore inside the project's history retention window | the Neon plan / project setting (section 3) |

- Nothing deletes off-host copies except the lifecycle rule. Local rotation never
  removes a remote copy, because the copy runs `sync` without `--delete`.
- The readiness posture `restore_verified` needs an off-host copy within 48 h and a
  drill within 35 days. The lifecycle rule must keep at least that much.
- A longer off-host window means a longer lifecycle expiry. Cost grows by about
  1.07 GB × 4 per day kept.

## 3. Neon point-in-time recovery: what the owner verifies

Do this in the Neon console as the owner. Nothing here was done by the agents.

1. **Restore window.** Console → the production project → **Settings** →
   **Instant restore** (named **History retention** on older consoles). Note the
   window, e.g. 1 day or 7 days, which depends on the plan. With the Neon API:
   `GET https://console.neon.tech/api/v2/projects/<project_id>` with an API key;
   read `project.history_retention_seconds`.
2. **Non-destructive restore test.** **Branches** → **Create branch** → parent
   `main` (the production branch) → **Past data** (point in time) → pick a time
   about one hour ago → create. This makes a new branch; production is not touched.
   With the API: `POST /api/v2/projects/<project_id>/branches` with
   `{"branch": {"parent_id": "<main branch id>", "parent_timestamp": "<ISO time>"}, "endpoints": [{"type": "read_only"}]}`.
3. **Check the branch.** Connect to the new branch's endpoint (its own connection
   string, never the production one) and run, for example:
   `SELECT max(recorded_at_utc) FROM platform_backup_records;` and
   `SELECT count(*) FROM users;`. The values must reflect the chosen time.
4. **Delete the test branch** (Branches → … → Delete). It uses compute while it
   exists.
5. Record the window and the date of the test (for example in the deployment
   record). The readiness fields `DATABASE_BACKUP_LAST_VERIFIED_AT` and
   `DATABASE_RESTORE_TESTED_AT` are the operator's statement of this check.

What PITR does **not** replace: it lives inside the same Neon project and account.
It does not survive losing that account or project. The off-host dump in section 1
is the copy outside the provider.
