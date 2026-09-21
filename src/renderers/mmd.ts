import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";

import "@babylonjs/core/Physics/physicsEngineComponent";
import "babylon-mmd/esm/Loader/pmxLoader";
import "babylon-mmd/esm/Runtime/Animation/mmdRuntimeModelAnimation";
import "babylon-mmd/esm/Runtime/Animation/mmdRuntimeCameraAnimation";
import ammoPhysics from "babylon-mmd/esm/Runtime/Physics/External/ammo.wasm";
import { MmdAmmoJSPlugin } from "babylon-mmd/esm/Runtime/Physics/mmdAmmoJSPlugin";
import { MmdAmmoPhysics } from "babylon-mmd/esm/Runtime/Physics/mmdAmmoPhysics";
import { SdefInjector } from "babylon-mmd/esm/Loader/sdefInjector";
import { MmdStandardMaterialBuilder } from "babylon-mmd/esm/Loader/mmdStandardMaterialBuilder";
import { MmdMaterialRenderMethod } from "babylon-mmd/esm/Loader/materialBuilderBase";
import { VmdLoader } from "babylon-mmd/esm/Loader/vmdLoader";
import { MmdRuntime } from "babylon-mmd/esm/Runtime/mmdRuntime";
import { MmdCamera } from "babylon-mmd/esm/Runtime/mmdCamera";
import type { MmdMesh } from "babylon-mmd/esm/Runtime/mmdMesh";
import type { MmdModel } from "babylon-mmd/esm/Runtime/mmdModel";
import type { MmdAnimation } from "babylon-mmd/esm/Loader/Animation/mmdAnimation";
import type { MmdRuntimeAnimationHandle } from "babylon-mmd/esm/Runtime/mmdRuntimeAnimationHandle";

import type { CharacterConfig, EmoteEntry, EmoteState } from "../character";
import type { CharacterRenderer } from "./types";

interface Vowel {
  name: string;
  open: number;
}

interface LoadedModel {
  mmdModel: MmdModel;
  mesh: MmdMesh;
  handles: Map<string, MmdRuntimeAnimationHandle>;
  playing: MmdRuntimeAnimationHandle | null;
  vowels: Vowel[];
  target: Vector3;
  radius: number;
}

// One queued clip: its runtime animation on the model, and the MMD-camera
// runtime animation from the emote's separate camera VMD (null when it has none).
interface Step {
  model: MmdRuntimeAnimationHandle;
  camera: MmdRuntimeAnimationHandle | null;
}

// A clip to play: the motion VMD name, plus an optional separate camera VMD.
interface ClipSpec {
  name: string;
  camera: string | null;
}

// Mouth shapes. Talking cycles these vowel morphs with an open/close envelope
// over a single mouth-free base motion. Names aren't standardized: stock MMD
// uses kana あいうえお, exported models use `Mouth_NN_0(TalkA_A_L)[M_Face]`.
const VOWEL_SPECS: { patterns: string[]; open: number }[] = [
  { patterns: ["あ", "TalkA_A_L", "TalkB_A_L", "_A_L"], open: 1.0 },
  { patterns: ["い", "TalkA_I_L", "TalkB_I_L", "TalkC_I", "_I_L"], open: 0.7 },
  { patterns: ["う", "TalkA_U_L", "_U_L"], open: 0.7 },
  { patterns: ["え", "TalkA_E_L", "TalkB_E_L", "_E_L"], open: 0.85 },
  { patterns: ["お", "TalkA_O_L", "_O_L"], open: 0.9 },
];
const VOWEL_HOLD_SECONDS = 0.22;
const TALK_FADE_RATE = 12;

// VMD candidates for an animation reference. A block-format `anim` already
// carries its extension (used as-is); a legacy stem gets `.vmd`, with the
// `(a)`-prefixed name some packs use as a fallback.
const HAS_EXTENSION = /\.[^.\s]+$/;
const vmdCandidates = (name: string): string[] =>
  HAS_EXTENSION.test(name) ? [name] : [`${name}.vmd`, `(a)${name}.vmd`];

/** Prefers an exact match (so "い" doesn't grab "笑い"), then substring. */
function resolveVowels(morphNames: string[]): Vowel[] {
  const vowels: Vowel[] = [];
  for (const spec of VOWEL_SPECS) {
    let found = spec.patterns.find((p) => morphNames.includes(p));
    if (!found) {
      for (const pattern of spec.patterns) {
        const match = morphNames.find((n) => n.includes(pattern));
        if (match) {
          found = match;
          break;
        }
      }
    }
    if (found) vowels.push({ name: found, open: spec.open });
  }
  return vowels;
}

/**
 * Renders an MMD (.pmx/.vmd) character. The "anim" phase loops the mouth-free
 * base motion (`<emote>.vmd`); "preanim"/"postanim" play those clips once.
 * Talking (independent of phase) layers vowel morphs on top. Binary model/motion
 * data needs a CORS-enabled host (unlike 2D sprites).
 */
export class MmdRenderer implements CharacterRenderer {
  private canvas: HTMLCanvasElement;
  private engine: Engine;
  private scene: Scene;
  private arcCamera: ArcRotateCamera; // orbit camera the viewer controls
  private mmdCamera: MmdCamera; // driven by a VMD's baked camera track
  private trackCamera = false;
  private cameraHandles = new Map<string, MmdRuntimeAnimationHandle>();
  private runtime!: MmdRuntime;
  private runtimeReady?: Promise<void>;
  private materialBuilder: MmdStandardMaterialBuilder;
  private vmdLoader: VmdLoader;

  private modelPromise: Promise<LoadedModel | null> | null = null;
  private motions = new Map<string, Promise<MmdAnimation | null>>();
  private active: LoadedModel | null = null;

  // A play queue of one-shot clips; the last loops when `loopLast`. Emote
  // transitions chain [prev postanim] -> [new preanim] -> loop(new anim) so the
  // model passes through its base pose instead of snapping between loops.
  private steps: Step[] = [];
  private stepIndex = 0;
  private loopLast = false;
  private pendingAdvance = false;
  private playingEmote: EmoteEntry | null = null;

  private talking = false;
  private talkTime = 0;
  private talkAmp = 0;

  constructor(private char: CharacterConfig) {
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "width:100%;height:100%;display:block;outline:none;touch-action:none";

    this.engine = new Engine(this.canvas, true, { alpha: true, stencil: true }, true);
    SdefInjector.OverrideEngineCreateEffect(this.engine);

    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0, 0, 0, 0);
    this.scene.ambientColor = new Color3(0.5, 0.5, 0.5);

    this.arcCamera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2, 32, new Vector3(0, 12, 0), this.scene);
    this.arcCamera.minZ = 0.1;
    this.arcCamera.maxZ = 5000;
    this.arcCamera.wheelDeltaPercentage = 0.01;
    this.arcCamera.lowerRadiusLimit = 1;
    this.arcCamera.upperRadiusLimit = 500;
    this.arcCamera.attachControl(this.canvas, false);

    // The orbit camera stays the scene's active camera; the MMD camera is only
    // made active while "track baked camera" is on and a clip has camera data.
    this.mmdCamera = new MmdCamera("mmdCamera", new Vector3(0, 10, 0), this.scene, false);

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.7;
    const dir = new DirectionalLight("dir", new Vector3(0.4, -1, 0.6), this.scene);
    dir.intensity = 0.7;

    this.materialBuilder = new MmdStandardMaterialBuilder();
    this.materialBuilder.renderMethod = MmdMaterialRenderMethod.AlphaEvaluation;
    this.guardTextureLoader();

    this.vmdLoader = new VmdLoader(this.scene);
    this.scene.onBeforeRenderObservable.add(() => this.updateTalk());
    // Runs at frame start, before the runtime's own beforePhysics (registered
    // later in initRuntime), so a queued clip swap applies cleanly from frame 0.
    this.scene.onBeforeAnimationsObservable.add(() => this.advancePending());

    this.engine.runRenderLoop(() => this.scene.render());
    this.onResize = () => this.engine.resize();
    window.addEventListener("resize", this.onResize);
  }

  private onResize: () => void;

  // Create the MMD runtime with an Ammo physics world (once) so PMX rigid
  // bodies and joints (skirt, hair, tail) are simulated. Ammo init is async,
  // so this is awaited before load.
  private ensureRuntime(): Promise<void> {
    if (!this.runtimeReady) this.runtimeReady = this.initRuntime();
    return this.runtimeReady;
  }

  private async initRuntime(): Promise<void> {
    // Ammo always fetches its wasm from new URL(..., import.meta.url), which the
    // bundler resolves to a blocked file:// path, and its ArrayBuffer fallback
    // only fires on a compile error, not that fetch rejection. Instantiate the
    // wasm ourselves (bytes from the dev server, see server.ts) via the
    // instantiateWasm hook, which short-circuits before any fetch.
    const wasmBinary = await (await fetch("/vendor/ammo.wasm.wasm")).arrayBuffer();
    const ammoInstance = await ammoPhysics({
      instantiateWasm(
        imports: WebAssembly.Imports,
        receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
      ) {
        WebAssembly.instantiate(wasmBinary, imports).then((r) => receive(r.instance, r.module));
        return {};
      },
    });
    const plugin = new MmdAmmoJSPlugin(true, ammoInstance);
    this.scene.enablePhysics(new Vector3(0, -98, 0), plugin);
    this.runtime = new MmdRuntime(this.scene, new MmdAmmoPhysics(this.scene));
    this.runtime.register(this.scene);
    // Drive the MMD camera off the same clock as the model, so its baked camera
    // track stays in sync with the body motion.
    this.runtime.addAnimatable(this.mmdCamera);
    // A clip pauses on reaching its end: advance to the next queued clip, or
    // loop the last one when the sequence loops.
    this.runtime.onPauseAnimationObservable.add(() => {
      const model = this.active;
      if (!model) return;
      const duration = this.runtime.animationFrameTimeDuration;
      const atEnd = duration > 0 && this.runtime.currentFrameTime >= duration - 1e-3;
      if (!atEnd) return;
      if (this.stepIndex < this.steps.length - 1) {
        // Defer the swap: switching handles here (mid-beforePhysics) would flash
        // the bind pose. advancePending() does it at the next frame start.
        this.pendingAdvance = true;
      } else if (this.loopLast) {
        // Looping reuses the same handle (no swap, no reset), so restart inline.
        this.runtime.seekAnimation(0, true);
        void this.runtime.playAnimation();
      }
    });
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.canvas);
    this.engine.resize();
  }

  async setEmote(emote: EmoteEntry, state: EmoteState): Promise<void> {
    const model = await this.ensureModel();
    if (!model) return;

    // Preanim/Postanim: play that single clip once (a stateless action).
    if (state === "preanim" || state === "postanim") {
      const clip = state === "preanim" ? emote.preanim : emote.postanim;
      const steps = await this.resolveSteps(model, [{ name: clip ?? emote.emote, camera: null }]);
      if (steps.length) this.playSteps(model, steps, false);
      this.playingEmote = null;
      return;
    }

    // "anim": loop just this emote's anim (+ its camera), no transition.
    if (state === "anim") {
      const steps = await this.resolveSteps(model, [{ name: emote.emote, camera: emote.camera }]);
      if (steps.length) this.playSteps(model, steps, true);
      this.playingEmote = emote;
      return;
    }

    // "auto" (emote selected): re-selecting the same emote keeps the running
    // loop; a change chains [prev postanim] -> [new preanim] -> loop(new anim).
    const prev = this.playingEmote;
    if (prev && prev.id === emote.id) return;
    const specs: ClipSpec[] = [];
    if (prev?.postanim) specs.push({ name: prev.postanim, camera: null }); // outro of the emote we leave
    if (emote.preanim) specs.push({ name: emote.preanim, camera: null }); // intro of the emote we enter
    specs.push({ name: emote.emote, camera: emote.camera }); // the loop, with its camera VMD
    const steps = await this.resolveSteps(model, specs);
    if (steps.length) this.playSteps(model, steps, true);
    this.playingEmote = emote;
  }

  /** Talking is orthogonal to the phase: mouth morphs layered over the motion. */
  setTalking(on: boolean): void {
    if (on) this.startTalk();
    else this.stopTalk();
  }

  /** Plays an arbitrary VMD by name (with or without a `.vmd` extension). */
  async playRaw(baseName: string): Promise<void> {
    const model = await this.ensureModel();
    if (!model) return;
    const steps = await this.resolveSteps(model, [{ name: baseName, camera: null }]);
    if (steps.length) this.playSteps(model, steps, true);
    // A raw clip leaves no emote to transition out of.
    this.playingEmote = null;
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
    this.canvas.remove();
  }

  // -- internals ------------------------------------------------------------

  private ensureModel(): Promise<LoadedModel | null> {
    if (this.modelPromise) return this.modelPromise;
    this.modelPromise = this.loadModel();
    return this.modelPromise;
  }

  private async loadModel(): Promise<LoadedModel | null> {
    try {
      await this.ensureRuntime();
      const url = this.char.source.url(this.char.model ?? "");
      if (!url) {
        console.warn(`Model ${this.char.model} not found for ${this.char.name}`);
        return null;
      }
      // Local folders hand babylon-mmd the textures directly (blob URLs can't
      // resolve the .pmx's relative texture paths); remote hosts return none,
      // so textures load by URL relative to the model as before.
      const referenceFiles = await this.char.source.textureFiles();
      const modelFile = this.char.model ?? "";
      const result = await ImportMeshAsync(url, this.scene, {
        // A blob: URL carries no extension, so name the plugin explicitly.
        pluginExtension: modelFile.slice(modelFile.lastIndexOf(".")) || ".pmx",
        name: modelFile,
        pluginOptions: {
          mmdmodel: {
            materialBuilder: this.materialBuilder,
            ...(referenceFiles ? { referenceFiles: referenceFiles as unknown as readonly File[] } : {}),
          },
        },
      });
      const mesh = result.meshes[0] as MmdMesh;
      const mmdModel = this.runtime.createMmdModel(mesh, { buildPhysics: true });
      const { target, radius } = this.frameFromSkeleton(mesh, result.skeletons?.[0]);
      const morphNames = Array.from(
        (mmdModel.morph as unknown as { _morphIndexMap: Map<string, number[]> })._morphIndexMap.keys(),
      );

      const model: LoadedModel = {
        mmdModel,
        mesh,
        handles: new Map(),
        playing: null,
        vowels: resolveVowels(morphNames),
        target,
        radius,
      };
      this.active = model;
      this.arcCamera.setTarget(target);
      this.arcCamera.radius = radius;
      this.engine.resize();
      return model;
    } catch (err) {
      console.warn(`Failed to load 3D model for ${this.char.name}:`, err);
      return null;
    }
  }

  /** Resolve clip names to steps in order, skipping any that don't load. */
  private async resolveSteps(model: LoadedModel, specs: ClipSpec[]): Promise<Step[]> {
    const steps: Step[] = [];
    for (const spec of specs) {
      const step = await this.resolveStep(model, spec);
      if (step) steps.push(step);
    }
    return steps;
  }

  /** Start playing a clip sequence; the last clip loops when `loopLast`. */
  private playSteps(model: LoadedModel, steps: Step[], loopLast: boolean): void {
    this.steps = steps;
    this.stepIndex = 0;
    this.loopLast = loopLast;
    this.pendingAdvance = false;
    if (steps.length > 0) this.playStep(model);
  }

  /** Apply a queued clip swap at frame start (see the onPause handler). */
  private advancePending(): void {
    if (!this.pendingAdvance) return;
    const model = this.active;
    if (!model) return;
    this.pendingAdvance = false;
    this.stepIndex++;
    this.playStep(model);
  }

  private playStep(model: LoadedModel): void {
    const step = this.steps[this.stepIndex];
    model.mmdModel.setRuntimeAnimation(step.model);
    model.playing = step.model;
    this.mmdCamera.setRuntimeAnimation(step.camera); // null clears any camera anim
    this.runtime.seekAnimation(0, true);
    void this.runtime.playAnimation();
    this.updateActiveCamera(step.camera !== null);
  }

  /** Switch to the MMD camera only while tracking and the clip has a camera VMD. */
  private updateActiveCamera(clipHasCamera: boolean): void {
    if (this.trackCamera && clipHasCamera) {
      if (this.scene.activeCamera !== this.mmdCamera) {
        this.arcCamera.detachControl();
        this.scene.activeCamera = this.mmdCamera;
      }
    } else if (this.scene.activeCamera !== this.arcCamera) {
      this.scene.activeCamera = this.arcCamera;
      this.arcCamera.attachControl(this.canvas, false);
    }
  }

  setCameraTracking(on: boolean): void {
    this.trackCamera = on;
    this.updateActiveCamera(this.steps[this.stepIndex]?.camera != null);
  }

  private startTalk(): void {
    if (this.talking) return;
    this.talking = true;
    this.talkTime = 0;
  }

  private stopTalk(): void {
    this.talking = false;
  }

  private updateTalk(): void {
    const model = this.active;
    if (!model) return;
    const { vowels } = model;
    if (vowels.length === 0) return;
    if (!this.talking && this.talkAmp <= 0) return;

    const dt = this.engine.getDeltaTime() / 1000;
    const targetAmp = this.talking ? 1 : 0;
    this.talkAmp += (targetAmp - this.talkAmp) * Math.min(1, dt * TALK_FADE_RATE);

    this.talkTime += dt;
    const idx = Math.floor(this.talkTime / VOWEL_HOLD_SECONDS) % vowels.length;
    const phase = (this.talkTime % VOWEL_HOLD_SECONDS) / VOWEL_HOLD_SECONDS;
    const envelope = Math.sin(phase * Math.PI);

    const morph = model.mmdModel.morph;
    for (let i = 0; i < vowels.length; i++) {
      morph.setMorphWeight(vowels[i].name, (i === idx ? envelope * vowels[i].open : 0) * this.talkAmp);
    }
    if (!this.talking && this.talkAmp <= 0.01) {
      for (const v of vowels) morph.setMorphWeight(v.name, 0);
      this.talkAmp = 0;
    }
  }

  /** Resolve a clip to a Step: its model animation, plus a camera animation
   * from the spec's separate camera VMD (null when absent or camera-less). */
  private async resolveStep(model: LoadedModel, spec: ClipSpec): Promise<Step | null> {
    let modelHandle: MmdRuntimeAnimationHandle | null = null;
    for (const rel of vmdCandidates(spec.name)) {
      const url = this.char.source.url(rel);
      if (!url) continue;
      const anim = await this.loadMotion(url);
      if (!anim) continue;
      modelHandle = model.handles.get(url) ?? model.mmdModel.createRuntimeAnimation(anim);
      model.handles.set(url, modelHandle);
      break;
    }
    if (!modelHandle) return null;

    const camera = spec.camera ? await this.resolveCameraHandle(spec.camera) : null;
    return { model: modelHandle, camera };
  }

  /** Camera runtime animation from a camera VMD, or null if it has no camera track. */
  private async resolveCameraHandle(name: string): Promise<MmdRuntimeAnimationHandle | null> {
    for (const rel of vmdCandidates(name)) {
      const url = this.char.source.url(rel);
      if (!url) continue;
      const cached = this.cameraHandles.get(url);
      if (cached) return cached;
      const anim = await this.loadMotion(url);
      if (!anim || anim.cameraTrack.frameNumbers.length === 0) continue;
      const handle = this.mmdCamera.createRuntimeAnimation(anim);
      this.cameraHandles.set(url, handle);
      return handle;
    }
    return null;
  }

  private loadMotion(url: string): Promise<MmdAnimation | null> {
    const cached = this.motions.get(url);
    if (cached) return cached;
    const promise: Promise<MmdAnimation | null> = this.vmdLoader
      .loadAsync(url, url)
      .catch((): MmdAnimation | null => null);
    this.motions.set(url, promise);
    return promise;
  }

  /**
   * Frames from skeleton bone positions, not the (bind-pose, often huge) mesh
   * bounds, so a posed character fills the view with feet near the bottom.
   */
  private frameFromSkeleton(
    mesh: MmdMesh,
    skeleton: { bones?: { getAbsolutePosition(): Vector3 }[] } | undefined,
  ): { target: Vector3; radius: number } {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const bone of skeleton?.bones ?? []) {
      const y = bone.getAbsolutePosition().y;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minY) || maxY - minY < 1e-3) {
      const b = mesh.getHierarchyBoundingVectors();
      minY = b.min.y;
      maxY = b.max.y;
    }
    const charHeight = Math.max(maxY - minY, 1);
    const viewTop = maxY + charHeight * 0.18;
    const viewBottom = minY - charHeight * 0.04;
    return {
      target: new Vector3(0, (viewTop + viewBottom) / 2, 0),
      radius: (viewTop - viewBottom) / 2 / Math.tan(this.arcCamera.fov / 2),
    };
  }

  /** Works around a babylon-mmd race that throws on late texture-load errors. */
  private guardTextureLoader(): void {
    const loader = (this.materialBuilder as unknown as {
      _textureLoader: {
        _loadingModels: Map<number, unknown>;
        _addErrorTextureReferenceCount(uniqueId: number, textureData: unknown): void;
      };
    })._textureLoader;
    if (!loader?._addErrorTextureReferenceCount) return;
    const original = loader._addErrorTextureReferenceCount.bind(loader);
    loader._addErrorTextureReferenceCount = (uniqueId: number, textureData: unknown): void => {
      if (!loader._loadingModels.get(uniqueId)) return;
      original(uniqueId, textureData);
    };
  }
}
