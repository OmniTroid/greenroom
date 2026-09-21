import type { CharacterConfig, EmoteEntry, EmoteState } from "../character";

/**
 * Renders one character into a container and shows its emotes/phases. The tool
 * talks only to this interface, so 2D (sprite) and 3D (MMD) characters are
 * interchangeable — `createRenderer` picks the implementation from the config.
 *
 * A renderer is bound to a single character (passed to its constructor via the
 * factory). Switching characters means disposing and creating a new one.
 */
export interface CharacterRenderer {
  /** Attach to the DOM. Call once. */
  mount(container: HTMLElement): void;

  /** Load (if needed) and display the given emote in the given phase. */
  setEmote(emote: EmoteEntry, state: EmoteState): Promise<void>;

  /**
   * Play an arbitrary asset by base name (a VMD for 3D, a sprite for 2D),
   * for authoring/debugging. Optional per renderer.
   */
  playRaw?(baseName: string): Promise<void>;

  /**
   * Drive the view from the animation's baked camera track instead of the
   * default camera. 3D only; absent on renderers without a baked camera.
   */
  setCameraTracking?(on: boolean): void;

  /** Tear down (stop loops, free GPU resources, remove DOM). */
  dispose(): void;
}

export type RendererFactory = (char: CharacterConfig) => CharacterRenderer;
