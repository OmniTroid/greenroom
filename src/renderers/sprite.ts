import type { CharacterConfig, EmoteEntry, EmoteState } from "../character";
import { imageExists } from "../request";
import type { CharacterRenderer } from "./types";

const EXTENSIONS = [".gif", ".apng", ".webp", ".png"];
const TRANSPARENT =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * Renders a 2D (sprite) AO character as a swapping <img>, mirroring the client's
 * emote resolution: idle = `(a)<emote>`, talking = `(b)<emote>`, preanim =
 * `<preanim>` (no prefix), across the usual animated extensions. A basic
 * preview today; the shared CharacterRenderer interface lets it grow (blips,
 * timed preanim -> idle, pairing) without the tool changing.
 */
export class SpriteRenderer implements CharacterRenderer {
  private img: HTMLImageElement;
  private token = 0;

  constructor(private char: CharacterConfig) {
    this.img = new Image();
    this.img.style.cssText =
      "position:absolute;height:100%;bottom:0;left:50%;top:50%;transform:translate(-50%,-50%)";
    this.img.src = TRANSPARENT;
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.img);
  }

  async setEmote(emote: EmoteEntry, state: EmoteState): Promise<void> {
    const prefix = state === "talking" ? "(b)" : state === "idle" ? "(a)" : "";
    const name = state === "preanim" && emote.preanim ? emote.preanim : emote.emote;
    const url = await this.resolve(prefix, name);
    // Guard against out-of-order resolution when the user clicks quickly.
    const mine = ++this.token;
    if (mine !== this.token) return;
    this.img.src = url ?? TRANSPARENT;
  }

  async playRaw(baseName: string): Promise<void> {
    const url = await this.resolve("", baseName);
    this.img.src = url ?? TRANSPARENT;
  }

  private async resolve(prefix: string, name: string): Promise<string | null> {
    const candidates: string[] = [];
    for (const ext of EXTENSIONS) {
      candidates.push(`${prefix}${name}${ext}`);
      // Some packs nest prefixed frames in an "(a)"/"(b)" folder.
      if (prefix) candidates.push(`${prefix}/${name}${ext}`);
    }
    // Unprefixed fallback (e.g. a plain `<emote>.png`).
    candidates.push(`${name}.png`);

    for (const rel of candidates) {
      const url = this.char.source.url(rel);
      if (url && (await imageExists(url))) return url;
    }
    return null;
  }

  dispose(): void {
    this.img.remove();
  }
}
