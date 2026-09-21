import "./index.css";
import { loadCharacter, type CharacterConfig, type EmoteEntry, type EmoteState } from "./character";
import { RemoteAssetSource, LocalAssetSource, ServedFolderSource, type AssetSource } from "./assets";
import { createRenderer, type CharacterRenderer } from "./renderers";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const urlInput = $<HTMLInputElement>("url");
const loadBtn = $<HTMLButtonElement>("load");
const pickDirBtn = $<HTMLButtonElement>("pickdir");
const emotesEl = $<HTMLDivElement>("emotes");
const animationsEl = $<HTMLDivElement>("animations");
const statusEl = $<HTMLDivElement>("status");
const stage = $<HTMLDivElement>("stage");
const rawInput = $<HTMLInputElement>("raw");
const playRawBtn = $<HTMLButtonElement>("playraw");
const stateButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("#states button"));

const setStatus = (msg: string) => (statusEl.textContent = msg);

const params = new URLSearchParams(location.search);
urlInput.value = params.get("url") ?? "";

// Character name from a folder URL: its last path segment.
const nameFromUrl = (u: string): string => {
  try {
    const path = new URL(u, location.href).pathname.replace(/\/+$/, "");
    return decodeURIComponent(path.split("/").pop() || "") || u;
  } catch {
    return u;
  }
};

let renderer: CharacterRenderer | null = null;
let character: CharacterConfig | null = null;
let currentEmote: EmoteEntry | null = null;
let state: EmoteState = "idle";

loadBtn.addEventListener("click", () => {
  const p = new URLSearchParams();
  if (urlInput.value.trim()) p.set("url", urlInput.value.trim());
  location.search = p.toString();
});
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadBtn.click();
});

pickDirBtn.addEventListener("click", async () => {
  if (!window.showDirectoryPicker) {
    setStatus("This browser has no folder picker (needs a Chromium-based browser).");
    return;
  }
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await window.showDirectoryPicker({ id: "greenroom-char", mode: "read" });
  } catch {
    return; // user dismissed the picker
  }
  setStatus(`Reading ${dir.name}…`);
  const source = await LocalAssetSource.fromDirectory(dir);
  await load(source, dir.name);
});

for (const btn of stateButtons) {
  btn.addEventListener("click", () => {
    state = btn.dataset.state as EmoteState;
    for (const b of stateButtons) b.classList.toggle("active", b === btn);
    if (renderer && currentEmote) void applyEmote(currentEmote);
  });
}

playRawBtn.addEventListener("click", () => {
  const base = rawInput.value.trim();
  if (base && renderer?.playRaw) {
    setStatus(`Playing ${base}…`);
    void renderer.playRaw(base).then(() => setStatus(`Playing ${base}`));
  }
});

const renderEmotes = (emotes: EmoteEntry[]): void => {
  emotesEl.innerHTML = "";
  if (emotes.length === 0) {
    emotesEl.innerHTML = '<span class="hint">No emotes in char.ini.</span>';
    return;
  }
  for (const emote of emotes) {
    const btn = document.createElement("button");
    btn.textContent = emote.desc || emote.emote;
    btn.title = `emote: ${emote.emote}${emote.preanim ? ` · preanim: ${emote.preanim}` : ""}`;
    btn.addEventListener("click", () => {
      clearActive(animationsEl);
      for (const b of emotesEl.querySelectorAll("button")) b.classList.remove("active");
      btn.classList.add("active");
      void applyEmote(emote);
    });
    emotesEl.appendChild(btn);
  }
};

const clearActive = (el: HTMLElement): void => {
  for (const b of el.querySelectorAll("button")) b.classList.remove("active");
};

// Lists the folder's raw .vmd files (local folders only) as loadable buttons,
// alongside the char.ini emotes. Plays through the renderer's playRaw.
const renderAnimations = (source: AssetSource): void => {
  const vmds = source.list(".vmd");
  animationsEl.innerHTML = "";
  if (vmds === null) {
    animationsEl.innerHTML = '<span class="hint">Open a local folder to list its .vmd files.</span>';
    return;
  }
  if (vmds.length === 0) {
    animationsEl.innerHTML = '<span class="hint">No .vmd files in this folder.</span>';
    return;
  }
  for (const rel of vmds) {
    const base = rel.slice(0, -".vmd".length);
    const btn = document.createElement("button");
    btn.textContent = base;
    btn.title = rel;
    btn.addEventListener("click", () => {
      clearActive(emotesEl);
      clearActive(animationsEl);
      btn.classList.add("active");
      void playAnimation(base);
    });
    animationsEl.appendChild(btn);
  }
};

const applyEmote = async (emote: EmoteEntry): Promise<void> => {
  if (!renderer || !character) return;
  currentEmote = emote;
  setStatus(`${character.name} · ${emote.emote} · ${state}…`);
  await renderer.setEmote(emote, state);
  setStatus(`${character.name} · ${emote.emote} · ${state}`);
};

const playAnimation = async (base: string): Promise<void> => {
  if (!character) return;
  if (!renderer?.playRaw) {
    setStatus("This renderer can't play raw animation files.");
    return;
  }
  currentEmote = null;
  setStatus(`${character.name} · ${base}…`);
  await renderer.playRaw(base);
  setStatus(`${character.name} · ${base}`);
};

const load = async (source: AssetSource, name: string): Promise<void> => {
  setStatus(`Loading char.ini for ${name}…`);
  try {
    character = await loadCharacter(source, name);
  } catch {
    setStatus(`Could not load char.ini for ${name} (${source.label}).`);
    return;
  }

  renderer?.dispose();
  renderer = await createRenderer(character);
  renderer.mount(stage);
  renderEmotes(character.emotes);
  renderAnimations(source);

  const kind = character.is3d ? `3D (${character.model})` : "2D sprites";
  const first = character.emotes[0];
  if (first) {
    emotesEl.querySelector("button")?.classList.add("active");
    await applyEmote(first);
    setStatus(`${character.name} · ${kind} · ${first.emote} · ${state}`);
  } else {
    setStatus(`${character.name} · ${kind} · no emotes`);
  }
};

const boot = async (): Promise<void> => {
  const folder = (params.get("folder") ?? "").trim();
  if (folder) {
    setStatus(`Reading ${folder}…`);
    let source: ServedFolderSource;
    try {
      source = await ServedFolderSource.fromPath(folder);
    } catch {
      setStatus(`Could not read folder ${folder}.`);
      return;
    }
    await load(source, folder.replace(/\/+$/, "").split("/").pop() || folder);
    return;
  }

  const url = (params.get("url") ?? "").trim();
  if (!url) {
    setStatus("Load a character from a URL or a local folder.");
    return;
  }
  await load(new RemoteAssetSource(url), nameFromUrl(url));
};

void boot();
