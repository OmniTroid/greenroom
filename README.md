# Green Room

Character preview / creation tool for Attorney Online characters. Loads a
character's `char.ini` and plays its emotes in idle / talking / preanim so you
can check assets before they hit the courtroom. 3D (MMD `.pmx`/`.vmd`) today,
2D sprites planned (the renderer is chosen from `char.ini`).

```bash
bun install
bun run dev
```

Load a character two ways. **From a URL:** the full URL to the folder holding
its `char.ini`, e.g. `?url=https://host/base/characters/Fenomeno3D/` (a remote
host needs CORS for 3D binary assets). A character dropped in
`assets/characters/<name>/` is served by the dev server, so
`?url=http://localhost:3000/characters/<name>/` works.

To load a folder off your disk, either click "Open folder…" and pick it
(Chromium-based browsers), or pass its absolute path so it loads on startup:
`?folder=/absolute/path/to/character`. The `?folder=` route is served by the
dev server reading that path directly, so it also lists the folder's `.vmd`
files as loadable buttons. Both local routes skip CORS and load 3D textures
straight from the folder.

## How it works

`src/renderers/` holds a `CharacterRenderer` interface with two
implementations, selected by `char.ini`:

- `mmd.ts` (3D): renders the `.pmx`, loops a mouth-free base motion per emote,
  and lip-syncs talking with vowel morphs (loaded lazily via Babylon).
- `sprite.ts` (2D): swaps the `(a)`/`(b)`/preanim sprite.

`character.ts` parses `char.ini` into a renderer-agnostic config; `main.ts` is
the UI and talks only to the interface. `assets.ts` abstracts where files come
from, so a remote host and a locally-picked folder are interchangeable.
