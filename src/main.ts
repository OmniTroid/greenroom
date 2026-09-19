import "./index.css";
import { loadCharacter, type CharacterConfig, type EmoteEntry, type EmoteState } from "./character";
import { createRenderer, type CharacterRenderer } from "./renderers";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const hostInput = $<HTMLInputElement>("host");
const charInput = $<HTMLInputElement>("char");
const loadBtn = $<HTMLButtonElement>("load");
const emotesEl = $<HTMLDivElement>("emotes");
const statusEl = $<HTMLDivElement>("status");
const stage = $<HTMLDivElement>("stage");
const rawInput = $<HTMLInputElement>("raw");
const playRawBtn = $<HTMLButtonElement>("playraw");
const stateButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("#states button"));

const setStatus = (msg: string) => (statusEl.textContent = msg);

const params = new URLSearchParams(location.search);
// Default to this server's own origin, so dropping a character in ./assets and
// typing its name just works with no host to configure.
const defaultHost = `${location.origin}/`;
hostInput.value = params.get("asset") ?? defaultHost;
charInput.value = params.get("char") ?? "";

let renderer: CharacterRenderer | null = null;
let character: CharacterConfig | null = null;
let currentEmote: EmoteEntry | null = null;
let state: EmoteState = "idle";

loadBtn.addEventListener("click", () => {
  const p = new URLSearchParams();
  if (hostInput.value) p.set("asset", hostInput.value.trim());
  if (charInput.value) p.set("char", charInput.value.trim());
  location.search = p.toString();
});
charInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadBtn.click();
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
      for (const b of emotesEl.querySelectorAll("button")) b.classList.remove("active");
      btn.classList.add("active");
      void applyEmote(emote);
    });
    emotesEl.appendChild(btn);
  }
};

const applyEmote = async (emote: EmoteEntry): Promise<void> => {
  if (!renderer || !character) return;
  currentEmote = emote;
  setStatus(`${character.name} — ${emote.emote} — ${state}…`);
  await renderer.setEmote(emote, state);
  setStatus(`${character.name} — ${emote.emote} — ${state}`);
};

const boot = async (): Promise<void> => {
  const name = (params.get("char") ?? "").trim();
  if (!name) {
    setStatus("Enter a host + character, then Load.");
    return;
  }
  const host = hostInput.value.trim();

  setStatus(`Loading char.ini for ${name}…`);
  try {
    character = await loadCharacter(host, name);
  } catch {
    setStatus(`Could not load char.ini for ${name} (host: ${host}).`);
    return;
  }

  renderer?.dispose();
  renderer = await createRenderer(character);
  renderer.mount(stage);
  renderEmotes(character.emotes);

  const kind = character.is3d ? `3D (${character.model})` : "2D sprites";
  const first = character.emotes[0];
  if (first) {
    emotesEl.querySelector("button")?.classList.add("active");
    await applyEmote(first);
    setStatus(`${character.name} — ${kind} — ${first.emote} — ${state}`);
  } else {
    setStatus(`${character.name} — ${kind} — no emotes`);
  }
};

void boot();
