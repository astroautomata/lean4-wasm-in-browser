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

## Source layout

```text
src/                              small release launcher
public/lean4game/                 generated Lean4Game application
public/visual-lean/               generated WASM runtime and module bundle
scripts/sync-lean4game-client.mjs release client/data synchronization
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
