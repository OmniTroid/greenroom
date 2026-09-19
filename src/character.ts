import { parseCharIni, type CharIni } from "aolib-ts";
import { request } from "./request";

/** Animation phase a character can be shown in. Applies to 2D and 3D alike. */
export type EmoteState = "idle" | "talking" | "preanim";

export interface EmoteEntry {
  /** 1-based index from char.ini [emotions]. */
  id: number;
  /** Button label / description. */
  desc: string;
  /** Sprite/motion base name (the animation stem). */
  emote: string;
  /** Pre-animation base name, or null if none ("-"). */
  preanim: string | null;
}

/**
 * A resolved AO character: its asset location, options, and emote table.
 * `is3d` (a `[options] model = *.pmx` key) selects which renderer is used;
 * everything else here is renderer-agnostic so 2D and 3D share this shape.
 */
export interface CharacterConfig {
  name: string;
  /** Asset host with trailing slash, e.g. "https://host/base/". */
  host: string;
  /** Full character folder URL: `${host}characters/${name.toLowerCase()}/`. */
  folder: string;
  showname: string;
  side: string;
  /** PMX file name for 3D characters, or null for 2D. */
  model: string | null;
  is3d: boolean;
  emotes: EmoteEntry[];
  /** The full parsed char.ini (aolib-ts), for anything not modeled above. */
  charIni: CharIni;
}

const withTrailingSlash = (host: string): string =>
  host && !host.endsWith("/") ? `${host}/` : host;

/**
 * Fetches a character's char.ini and folds it (via aolib-ts `parseCharIni`)
 * into a renderer-agnostic config. Values are lowercased at the point of use
 * here, since asset URLs are case-insensitive by AO convention.
 */
export async function loadCharacter(rawHost: string, name: string): Promise<CharacterConfig> {
  const host = withTrailingSlash(rawHost.trim());
  const folder = `${host}characters/${encodeURI(name.toLowerCase())}/`;
  const charIni = parseCharIni(await request(`${folder}char.ini`));

  const model = (charIni.options.model ?? "").trim().toLowerCase();
  const emotes: EmoteEntry[] = charIni.emotes.map((e) => ({
    id: e.id,
    desc: e.name,
    emote: e.anim.toLowerCase(),
    preanim: e.preanim && e.preanim !== "-" ? e.preanim.toLowerCase() : null,
  }));

  return {
    name,
    host,
    folder,
    showname: charIni.options.showname || name,
    side: (charIni.options.side || "wit").toLowerCase(),
    model: model || null,
    is3d: !!model,
    emotes,
    charIni,
  };
}
