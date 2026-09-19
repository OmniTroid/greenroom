import type { CharacterConfig } from "../character";
import type { CharacterRenderer } from "./types";
import { SpriteRenderer } from "./sprite";

export type { CharacterRenderer } from "./types";

/**
 * Picks a renderer for the character. 3D (MMD) pulls in Babylon lazily via a
 * dynamic import so the 2D path never pays for the (large) 3D runtime.
 *
 * Returns a promise because the 3D module is code-split; the 2D renderer
 * resolves immediately.
 */
export async function createRenderer(char: CharacterConfig): Promise<CharacterRenderer> {
  if (char.is3d) {
    const { MmdRenderer } = await import("./mmd");
    return new MmdRenderer(char);
  }
  return new SpriteRenderer(char);
}
