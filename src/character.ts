import { parseCharIni, type CharIni } from "aolib-ts";
import type { AssetSource } from "./assets";

/**
 * Animation phase to show an emote in. `auto` is natural playback: switching
 * emotes chains the old emote's postanim, the new one's preanim, then loops its
 * anim. `anim` loops just the anim; `preanim`/`postanim` play that clip once.
 * Talking (mouth) is orthogonal to all of these.
 */
export type EmoteState = "auto" | "preanim" | "anim" | "postanim";

export interface EmoteEntry {
  /** 1-based index from char.ini [emotions]. */
  id: number;
  /** Button label / description. */
  desc: string;
  /** Sprite/motion base name (the animation stem). */
  emote: string;
  /** Pre-animation (intro), played once before the loop, or null if none. */
  preanim: string | null;
  /** Post-animation (outro), played once when leaving this emote, or null. */
  postanim: string | null;
  /** Separate camera VMD driving the view during this emote, or null. */
  camera: string | null;
}

/**
 * A resolved AO character: its asset location, options, and emote table.
 * `is3d` (a `[options] model = *.pmx` key) selects which renderer is used;
 * everything else here is renderer-agnostic so 2D and 3D share this shape.
 */
export interface CharacterConfig {
  name: string;
  /** Where this character's files come from (remote host or local folder). */
  source: AssetSource;
  showname: string;
  side: string;
  /** PMX file name for 3D characters, or null for 2D. */
  model: string | null;
  is3d: boolean;
  emotes: EmoteEntry[];
  /** The full parsed char.ini (aolib-ts), for anything not modeled above. */
  charIni: CharIni;
}

/**
 * Reads a character's char.ini from the given source and folds it (via aolib-ts
 * `parseCharIni`) into a renderer-agnostic config. Values are lowercased at the
 * point of use here, since asset paths are case-insensitive by AO convention.
 */
export async function loadCharacter(source: AssetSource, name: string): Promise<CharacterConfig> {
  const charIni = parseCharIni(await source.text("char.ini"));

  const model = (charIni.options.model ?? "").trim().toLowerCase();
  // aolib-ts normalizes both encodings: `[emote]` blocks give the animation
  // fields as full filenames with extension; legacy banks give bare stems and
  // null for absent ones. Renderers accept either (see the mmd renderer).
  // Emotes are a sorted list, so the id is just the position.
  const lower = (v: string | null): string | null => v?.toLowerCase() ?? null;
  const emotes: EmoteEntry[] = charIni.emotes.map((e, i) => ({
    id: i + 1,
    desc: e.name,
    emote: e.anim.toLowerCase(),
    preanim: lower(e.preanim),
    postanim: lower(e.postanim),
    camera: lower(e.camera),
  }));

  return {
    name,
    source,
    showname: charIni.options.showname || name,
    side: (charIni.options.side || "wit").toLowerCase(),
    model: model || null,
    is3d: !!model,
    emotes,
    charIni,
  };
}
