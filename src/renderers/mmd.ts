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
import ammoPhysics from "babylon-mmd/esm/Runtime/Physics/External/ammo.wasm";
import { MmdAmmoJSPlugin } from "babylon-mmd/esm/Runtime/Physics/mmdAmmoJSPlugin";
import { MmdAmmoPhysics } from "babylon-mmd/esm/Runtime/Physics/mmdAmmoPhysics";
import { SdefInjector } from "babylon-mmd/esm/Loader/sdefInjector";
import { MmdStandardMaterialBuilder } from "babylon-mmd/esm/Loader/mmdStandardMaterialBuilder";
import { MmdMaterialRenderMethod } from "babylon-mmd/esm/Loader/materialBuilderBase";
import { VmdLoader } from "babylon-mmd/esm/Loader/vmdLoader";
import { MmdRuntime } from "babylon-mmd/esm/Runtime/mmdRuntime";
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
 * Renders an MMD (.pmx/.vmd) character. idle and talking share one mouth-free
 * base motion (`<emote>.vmd`); talking layers vowel morphs on top. preanim
 * plays `<preanim>.vmd` once. Binary model/motion data needs a CORS-enabled
 * host (unlike 2D sprites).
 */
export class MmdRenderer implements CharacterRenderer {
  private canvas: HTMLCanvasElement;
  private engine: Engine;
  private scene: Scene;
  private camera: ArcRotateCamera;
  private runtime!: MmdRuntime;
  private runtimeReady?: Promise<void>;
  private materialBuilder: MmdStandardMaterialBuilder;
  private vmdLoader: VmdLoader;

  private modelPromise: Promise<LoadedModel | null> | null = null;
  private motions = new Map<string, Promise<MmdAnimation | null>>();
  private active: LoadedModel | null = null;

  private looping = false;
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

    this.camera = new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2, 32, new Vector3(0, 12, 0), this.scene);
    this.camera.minZ = 0.1;
    this.camera.maxZ = 5000;
    this.camera.wheelDeltaPercentage = 0.01;
    this.camera.lowerRadiusLimit = 1;
    this.camera.upperRadiusLimit = 500;
    this.camera.attachControl(this.canvas, false);

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.7;
    const dir = new DirectionalLight("dir", new Vector3(0.4, -1, 0.6), this.scene);
    dir.intensity = 0.7;

    this.materialBuilder = new MmdStandardMaterialBuilder();
    this.materialBuilder.renderMethod = MmdMaterialRenderMethod.AlphaEvaluation;
    this.guardTextureLoader();

    this.vmdLoader = new VmdLoader(this.scene);
    this.scene.onBeforeRenderObservable.add(() => this.updateTalk());

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
    // Ammo's wasm streaming path hardcodes a fetch against its own module URL,
    // which the bundler resolves to a blocked file:// path (locateFile is
    // ignored on that path). Hand it the bytes from the dev server (see
    // server.ts) as wasmBinary so it skips fetching entirely.
    const wasmBinary = await (await fetch("/vendor/ammo.wasm.wasm")).arrayBuffer();
    const ammoInstance = await ammoPhysics({ wasmBinary });
    const plugin = new MmdAmmoJSPlugin(true, ammoInstance);
    this.scene.enablePhysics(new Vector3(0, -98, 0), plugin);
    this.runtime = new MmdRuntime(this.scene, new MmdAmmoPhysics(this.scene));
    this.runtime.register(this.scene);
    this.runtime.onPauseAnimationObservable.add(() => {
      if (!this.looping) return;
      const duration = this.runtime.animationFrameTimeDuration;
      if (duration > 0 && this.runtime.currentFrameTime >= duration - 1e-3) {
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

    const baseCandidates = [`${emote.emote}.vmd`, `(a)${emote.emote}.vmd`];

    if (state === "preanim") {
      this.stopTalk();
      const preanimRel = emote.preanim ? `${emote.preanim}.vmd` : null;
      const handle = await this.resolveHandle(model, preanimRel ? [preanimRel] : baseCandidates);
      if (handle) this.playHandle(model, handle, false);
      return;
    }

    const handle = await this.resolveHandle(model, baseCandidates);
    if (handle && model.playing !== handle) this.playHandle(model, handle, true);
    if (state === "talking") this.startTalk();
    else this.stopTalk();
  }

  /** Plays an arbitrary VMD (by base name, without extension) on the model. */
  async playRaw(baseName: string): Promise<void> {
    const model = await this.ensureModel();
    if (!model) return;
    const handle = await this.resolveHandle(model, [`${baseName}.vmd`]);
    if (handle) this.playHandle(model, handle, true);
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
      this.camera.setTarget(target);
      this.camera.radius = radius;
      this.engine.resize();
      return model;
    } catch (err) {
      console.warn(`Failed to load 3D model for ${this.char.name}:`, err);
      return null;
    }
  }

  private playHandle(model: LoadedModel, handle: MmdRuntimeAnimationHandle, loop: boolean): void {
    this.looping = loop;
    model.mmdModel.setRuntimeAnimation(handle);
    model.playing = handle;
    this.runtime.seekAnimation(0, true);
    void this.runtime.playAnimation();
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

  private async resolveHandle(
    model: LoadedModel,
    candidates: string[],
  ): Promise<MmdRuntimeAnimationHandle | null> {
    for (const rel of candidates) {
      const url = this.char.source.url(rel);
      if (!url) continue;
      const cached = model.handles.get(url);
      if (cached) return cached;
      const anim = await this.loadMotion(url);
      if (anim) {
        const handle = model.mmdModel.createRuntimeAnimation(anim);
        model.handles.set(url, handle);
        return handle;
      }
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
      radius: (viewTop - viewBottom) / 2 / Math.tan(this.camera.fov / 2),
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
