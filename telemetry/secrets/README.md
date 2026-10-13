# Telemetry secrets

Everything in this directory except this README is ignored by git and by the
Docker build context. Compose mounts each file as a secret
(`compose.yml`, `secrets:`); nothing reads them from the environment.

| File | Used by | Contents |
| --- | --- | --- |
| `postgres_password` | `postgres` (first initialisation only), `migrate` | bootstrap superuser (`POSTGRES_USER`) password |
| `telemetry_writer_password` | `collector`, `migrate`, `verify-permissions` | runtime intake role |
| `telemetry_compactor_password` | `compactor`, `migrate`, `verify-permissions` | compaction worker |
| `telemetry_reader_password` | `exporter`, `migrate`, `verify-permissions` | exports and replay extraction (read-only) |
| `telemetry_retention_password` | `retention`, `migrate`, `verify-permissions` | policy-gated retention job |
| `telemetry_backup_password` | `ops/backup.sh`, `migrate`, `verify-permissions` | `pg_dump` (read-only) |

Create them once, as root on the host, from a random source (role passwords
must be at least 16 characters):

```sh
cd telemetry
install -d -m 0700 secrets
for name in telemetry_writer telemetry_compactor telemetry_reader telemetry_retention telemetry_backup; do
  ( umask 077; openssl rand -hex 32 > "secrets/${name}_password" )
done
# Existing deployment: the CURRENT superuser password from the old .env
# (POSTGRES_PASSWORD=...), not a new one; see docs/operations.md.
( umask 077; printf '%s\n' 'paste-the-existing-password' > secrets/postgres_password )
chgrp 10001 secrets/*_password      # TELEMETRY_SECRETS_GID
chmod 0440 secrets/*_password
```

Compose bind-mounts these files unchanged (it ignores `uid`/`mode` for file
secrets), so the files are group-readable by `TELEMETRY_SECRETS_GID` and every
consuming container runs with that supplementary group. A container can only
read the files listed for its service.

Rotating a role password: write the new file, run
`docker compose run --rm migrate` (it sets the password of every role whose
file is present), then restart the services that use it. The superuser
password is changed with `ALTER ROLE ... PASSWORD` through the migrate
credential and then written here; changing this file alone does nothing for
an existing volume.
