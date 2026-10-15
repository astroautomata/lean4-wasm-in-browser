# The Natural Numbers Game in the browser

This site ships two versions of The Natural Numbers Game plus a Visual Lean
capabilities demo:

- **Vanilla NNG4** — the original tactic-based Lean4Game experience.
- **Visual Lean** — the full NNG4 curriculum with direct, visual proof
  manipulation.

Both games use the same persistent, single-threaded Lean WebAssembly worker.
Proof checking runs locally in the browser; there is no hosted Lean server.
The Lean environment is loaded once and reused while the player moves between
levels in any order. Algorithm World is intentionally excluded.

## Local development

Generated release assets are expected at:

```text
public/lean4game/                  Lean4Game client and game data
public/visual-lean/runtime/        lean.js and lean.wasm
public/visual-lean/modules/        reduced Lean module closure
public/lean-worker-persistent.worker.js
```

Start the site with `npm install` and `npm run dev`, then open
`http://localhost:5173`.

To rebuild and copy the Lean4Game client and metadata from the sibling
`Lean4Game` checkout, run `npm run sync-lean4game-client`. The sync packages
NNG4 and the Visual Capabilities Demo while excluding Algorithm World and the
unreferenced duplicate public font tree.

## Production release

`.github/workflows/docker-release.yml` builds the single canonical release. It:

1. builds the no-pthread Lean WASM runtime and reduced module closure;
2. assembles and publishes the nginx image;
3. validates all 66 Visual NNG levels and classic export;
4. extracts that exact validated image and deploys it to GitHub Pages.

The runtime does not use `SharedArrayBuffer`, so static hosting does not need
COOP/COEP response headers.

The optional telemetry collector is independent of Lean and the static site.
Its PostgreSQL schema, Docker Compose deployment, CORS settings, privacy notes,
and reporting queries are documented in [`telemetry/README.md`](telemetry/README.md).

The workflow publishes:

```text
ghcr.io/astroautomata/lean4-wasm-in-browser:latest
ghcr.io/astroautomata/lean4-wasm-in-browser:sha-<commit>
```

Run the container with:

```bash
docker run --detach \
  --name natural-numbers-game \
  --restart unless-stopped \
  --publish 8080:80 \
  ghcr.io/astroautomata/lean4-wasm-in-browser:latest
```

## GitHub Pages and custom domain

GitHub Pages deploys the validated static tree at the repository's Pages site.
The repository Pages setting uses this custom domain:

```text
leangame.autumnofautumn.com
```

The DNS record for that subdomain must be a `CNAME` pointing directly to:

```text
astroautomata.github.io
```

Do not include the repository name in the CNAME target. The application uses
root-relative asset URLs because the custom domain serves this project at `/`.

## Asset hosting

GitHub Pages has a soft bandwidth limit of 100 GB a month, and each new player
downloads about 95 MB of Lean runtime and modules. The Pages deploy can
therefore serve those three files from a Cloudflare R2 bucket instead, which
doesn't charge for egress. The Docker image and the release gates are not
affected: only the Pages copy changes.

Before each Pages deploy, `scripts/publish-r2-assets.sh` (the "Publish Lean
assets to R2" step in both Pages workflows):

1. uploads `lean.wasm`, `lean.js` and `game-modules.tar.gz` once under
   `visual-lean/<version>/`, where `<version>` is a hash of the three files.
   A prefix is complete when its `manifest.json` exists; objects are never
   overwritten or deleted, so they are cached as immutable;
2. downloads each file through the public URL with the site's `Origin`, and
   checks status, CORS headers, content type and encoding, and the SHA-256;
3. writes `visual-lean/asset-base.json`, which tells the client where to load
   from.

If the upload or a check fails, the deploy stops. The Pages copy keeps its own
files, and the client falls back to them if Lean fails to start from R2.

Configuration is in repository secrets (Settings → Secrets and variables →
Actions). Because they are secrets, the logs show their values, including
the bucket name and the public URL, as `***`:

| Secret | Value |
| --- | --- |
| `R2_ACCESS_KEY_ID` | Access Key ID of an R2 API token with Object Read & Write on this bucket only |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key of the same token |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_BUCKET` | `leangame-assets` |
| `R2_PUBLIC_BASE` | `https://assets.autumnofautumn.com` (unset = off) |

The bucket needs the custom domain `assets.autumnofautumn.com`, and a CORS
policy allowing `GET` and `HEAD` from `https://leangame.autumnofautumn.com`
with `Content-Encoding` in `ExposeHeaders` (the worker reads that header to
decide whether to gunzip the module bundle itself). Don't add lifecycle
(auto-delete) rules: an unchanged runtime keeps its prefix across many
deploys.

To roll back, delete the `R2_PUBLIC_BASE` secret and run "Publish latest browser image to
GitHub Pages". The site then has no `asset-base.json` and loads everything from
Pages.

## Source layout

```text
src/                              small release launcher
public/lean4game/                 generated Lean4Game application
public/visual-lean/               generated WASM runtime and module bundle
scripts/sync-lean4game-client.mjs release client/data synchronization
scripts/publish-r2-assets.sh      R2 upload for the Pages deploy
telemetry/                        optional PostgreSQL event collector
```

## License

Visual Lean is licensed under the **GNU General Public License v3.0** — see
[LICENSE](LICENSE).

The published site is a combined work built from:

- [lean4game](https://github.com/leanprover-community/lean4game) — GPL-3.0,
  which is why the combined work is GPL-3.0
- [The Natural Number Game](https://github.com/leanprover-community/NNG4) — Apache-2.0
- [Lean 4](https://github.com/leanprover/lean4) and Mathlib — Apache-2.0
- [monaco-vscode-api](https://github.com/CodinGame/monaco-vscode-api) — MIT

Apache-2.0 and MIT are one-way compatible into GPL-3.0, so they impose no
additional conditions on the whole; their own copyright and attribution
notices are retained.
