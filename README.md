# markdown-render-speed-02

A dependency-free CommonMark 0.31.2 + GFM 0.29 renderer whose `parse(markdown)`
returns the same HTML as marked 18.1.3 with default options, built for the
make.fun `markdown-render-speed-02` competition ($250, top 20).

## Layout

- `parse.js` — the entrypoint. A from-scratch CommonMark/GFM parser that
  renders the common cases directly and falls back to vendored marked for
  anything it cannot handle, so output stays byte-identical to marked.
- `main.ts` — the harness driver. Reads `/input/cases.json` (a JSON array of
  `{id, markdown}`), renders each case alone with `parse`, writes
  `/output/html.json` (a JSON array of HTML strings, in order).
- `vendor/marked/` — marked 18.1.3 (`marked.esm.js`, `LICENSE`, `NOTICE`),
  used only as the correctness fallback inside `parse.js`.

## Run

```sh
MAKEFUN_INPUT_DIR=<dir-with-cases.json> MAKEFUN_OUTPUT_DIR=<out-dir> node main.ts
```

Node 22, no install, no network, no native addons.

## License

MIT — see `LICENSE`. Marked is MIT — see `vendor/marked/LICENSE`.
