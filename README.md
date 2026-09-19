# Green Room

Character preview / creation tool for Attorney Online characters. Loads a
character's `char.ini` and plays its emotes in idle / talking / preanim so you
can check assets before they hit the courtroom. 3D (MMD `.pmx`/`.vmd`) today,
2D sprites planned (the renderer is chosen from `char.ini`).

```bash
bun install
bun run dev
```

Put a character folder in `assets/characters/<name>/`, then open
`http://localhost:3000/?char=<name>`. To preview against a remote server
instead, pass `?asset=<host>` (needs CORS for 3D binary assets).

## How it works

`src/renderers/` holds a `CharacterRenderer` interface with two
implementations, selected by `char.ini`:

- `mmd.ts` — 3D: renders the `.pmx`, loops a mouth-free base motion per emote,
  and lip-syncs talking with vowel morphs (loaded lazily via Babylon).
- `sprite.ts` — 2D: swaps the `(a)`/`(b)`/preanim sprite.

`character.ts` parses `char.ini` into a renderer-agnostic config; `main.ts` is
the UI and talks only to the interface.
