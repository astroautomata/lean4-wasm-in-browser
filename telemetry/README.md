# Lean game telemetry collector

This is the optional, separately hosted collector for the static GitHub Pages
game. It stores pseudonymous level attempts and ordered proof paths in
PostgreSQL. It does not execute Lean and is not part of proof validation.

## Deploy with PostgreSQL

1. Point `telemetry.leangame.autumnofautumn.com` at the telemetry server.
2. Copy this directory's `.env.example` to `.env` and replace the database
   password with a long random value. Do not commit `.env`.
3. Run `docker compose -f compose.yml pull` and then
   `docker compose -f compose.yml up -d`.
   The included Watchtower service checks every five minutes by default and
   replaces the collector when a new `latest` image is published. Only the
   collector opts in; Watchtower does not update PostgreSQL. Adjust
   `WATCHTOWER_POLL_INTERVAL` in `.env` if desired.
4. Reverse proxy HTTPS to `127.0.0.1:8090` when Caddy runs on the host. For
   Caddy:

   ```caddyfile
   telemetry.leangame.autumnofautumn.com {
       reverse_proxy 127.0.0.1:8090
       log {
           output discard
       }
   }
   ```

   In your existing setup Caddy itself runs in Docker. The cleaner arrangement
   is to copy the `postgres` and `collector` services and the
   `telemetry_postgres` volume into that same Compose file, remove the
   collector's `ports` block, and proxy over the shared Compose network:

   ```caddyfile
   telemetry.leangame.autumnofautumn.com {
       reverse_proxy collector:8080
       log {
           output discard
       }
   }
   ```

5. Verify `https://telemetry.leangame.autumnofautumn.com/healthz` returns
   `{"status":"ok"}`.

Watchtower needs the Docker socket in order to replace the collector, which
effectively gives that container administrative control over Docker on the
host. The Compose file pins Watchtower to `1.7.1` and opts in only the
collector. Note that the upstream Watchtower project was archived in December
2025; keep the pin explicit and revisit this updater if Docker compatibility
changes.

Check updater activity with:

```sh
docker compose -f compose.yml logs --tail=100 watchtower
```

The collector applies its idempotent migration automatically at startup. It
accepts either `DATABASE_URL` or the standard PostgreSQL `PGHOST`, `PGUSER`,
`PGPASSWORD`, `PGDATABASE`, and `PGPORT` variables. The
database is not exposed outside Docker. Back up the `telemetry_postgres` volume
with your normal PostgreSQL backup process (`pg_dump` is sufficient).

For a different collector URL, build the website with
`VITE_TELEMETRY_URL=https://your-collector.example`. Set `ALLOWED_ORIGINS` to
the exact comma-separated site origins allowed to submit events; include a
localhost origin only while developing.

## Data model

- `anonymous_users` stores a random UUID plus first/last seen times.
- `proof_attempts` stores game/world/level/mode once, completion status, final
  scripts, and an optional link from a classic export to its Visual attempt.
- `proof_steps` stores the ordered path. Visual steps are commands/undo;
  classic editor steps are compact line edits (`from_line`, `removed_lines`,
  inserted `command`) rather than repeated copies of the whole proof.
- `attributes jsonb` columns provide an extension point without schema changes.
- `feedback_reports` stores a player-submitted message with its game, level,
  mode, and current proof state. Its `user_id` is nullable and is populated
  only when the player has enabled anonymous telemetry.

PostgreSQL automatically TOAST-compresses larger scripts. Normalization avoids
repeating UUID and level strings for every step, and PostgreSQL enums encode
the repeated mode/action labels in four bytes. Idempotent event UUIDs and
`(attempt_id, sequence)` uniqueness make browser retries safe.

Example completion report:

```sql
SELECT game_id, world_id, level_id, mode,
       count(*) AS attempts,
       count(*) FILTER (WHERE completed) AS completions,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)
         FILTER (WHERE completed) AS median_completion_ms
FROM proof_attempts
GROUP BY game_id, world_id, level_id, mode
ORDER BY game_id, world_id, level_id, mode;
```

Example reconstructed path input:

```sql
SELECT sequence, elapsed_ms, step_type, command, from_line, removed_lines
FROM proof_steps
WHERE attempt_id = '00000000-0000-0000-0000-000000000000'
ORDER BY sequence;
```

The application asks for opt-in consent. On acceptance it creates the
first-party `lean_game_anonymous_id` cookie on the game site. The identifier is
sent in the JSON body because third-party cookies should not be used for the
separate collector origin. Refusal deletes the identifier and pending events.
The collector code does not write IP addresses or user-agent strings; disable
access logging in the reverse proxy as shown if those must not be retained
there either.
