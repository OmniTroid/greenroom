import type { IArrayBufferFile } from "babylon-mmd/esm/Loader/referenceFileResolver";
import { request } from "./request";

/**
 * Where a character's files come from. Renderers resolve everything (char.ini,
 * sprites, motions, model + textures) through this, so a remote AO host and a
 * locally-picked folder are interchangeable.
 */
export interface AssetSource {
  /** Short human label (host or folder name) for status/error text. */
  readonly label: string;
  /** Read a text asset (i.e. char.ini) at a folder-relative path. */
  text(path: string): Promise<string>;
  /** A loadable URL for a folder-relative asset, or null if known-absent. */
  url(path: string): string | null;
  /**
   * Folder-relative paths of every file with the given extension (e.g. ".vmd"),
   * sorted. null when the source can't be enumerated (a remote host).
   */
  list(extension: string): string[] | null;
  /**
   * babylon-mmd reference files so a .pmx resolves its textures from the picked
   * folder instead of the network. undefined for remote sources, whose textures
   * load by URL relative to the model.
   */
  textureFiles(): Promise<readonly IArrayBufferFile[] | undefined>;
}

const withTrailingSlash = (host: string): string =>
  host && !host.endsWith("/") ? `${host}/` : host;

/** Serves a character from a remote AO asset host over HTTP. */
export class RemoteAssetSource implements AssetSource {
  readonly label: string;
  private readonly base: string;

  constructor(rawHost: string, name: string) {
    const host = withTrailingSlash(rawHost.trim());
    this.label = host;
    this.base = `${host}characters/${encodeURI(name.toLowerCase())}/`;
  }

  text(path: string): Promise<string> {
    return request(this.base + encodeURI(path));
  }

  url(path: string): string {
    return this.base + encodeURI(path);
  }

  list(): null {
    return null;
  }

  async textureFiles(): Promise<undefined> {
    return undefined;
  }
}

/**
 * Serves a character from an absolute local folder read by the dev server
 * (`/@local` + `/@list`). Unlike the File System Access picker this needs no
 * click, so it can auto-load from a `?folder=` query param. Same-origin URLs,
 * so textures load by URL like a remote host (no reference files needed).
 */
export class ServedFolderSource implements AssetSource {
  readonly label: string;
  private readonly base: string;
  private readonly files: readonly string[];

  private constructor(absPath: string, files: readonly string[]) {
    const clean = absPath.replace(/\/+$/, "");
    this.label = clean;
    this.base = `/@local${clean.split("/").map(encodeURIComponent).join("/")}/`;
    this.files = files;
  }

  static async fromPath(absPath: string): Promise<ServedFolderSource> {
    const res = await fetch(`/@list?dir=${encodeURIComponent(absPath)}`);
    if (!res.ok) throw new Error(`Cannot read folder ${absPath}`);
    return new ServedFolderSource(absPath, (await res.json()) as string[]);
  }

  text(path: string): Promise<string> {
    return request(this.base + encodeURI(path));
  }

  url(path: string): string {
    return this.base + encodeURI(path);
  }

  list(extension: string): string[] {
    const ext = extension.toLowerCase();
    return this.files.filter((f) => f.toLowerCase().endsWith(ext)).sort();
  }

  async textureFiles(): Promise<undefined> {
    return undefined;
  }
}

const TEXTURE_EXTS = new Set(["png", "jpg", "jpeg", "bmp", "gif", "tga", "dds", "spa", "sph"]);
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  bmp: "image/bmp",
  gif: "image/gif",
};
const extOf = (name: string): string => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

/**
 * Serves a character from a locally-picked folder (File System Access API).
 * Files are walked once into a lowercased path map; asset URLs are lazily
 * minted object URLs. For 3D, texture files are handed to babylon-mmd as
 * reference files keyed by their folder-relative path (which is what the .pmx
 * stores), so no network fetch is needed for the model's textures.
 */
export class LocalAssetSource implements AssetSource {
  readonly label: string;
  private readonly files = new Map<string, File>();
  private readonly urls = new Map<string, string>();
  private textures: Promise<readonly IArrayBufferFile[]> | null = null;

  private constructor(label: string) {
    this.label = label;
  }

  static async fromDirectory(dir: FileSystemDirectoryHandle): Promise<LocalAssetSource> {
    const src = new LocalAssetSource(dir.name);
    await src.walk(dir, "");
    return src;
  }

  private async walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    for await (const handle of dir.values()) {
      const rel = prefix ? `${prefix}/${handle.name}` : handle.name;
      if (handle.kind === "file") {
        this.files.set(rel.toLowerCase(), await handle.getFile());
      } else {
        await this.walk(handle, rel);
      }
    }
  }

  async text(path: string): Promise<string> {
    const file = this.files.get(path.toLowerCase());
    if (!file) throw new Error(`${path} not found in folder`);
    return file.text();
  }

  url(path: string): string | null {
    const key = path.toLowerCase();
    const existing = this.urls.get(key);
    if (existing) return existing;
    const file = this.files.get(key);
    if (!file) return null;
    const objectUrl = URL.createObjectURL(file);
    this.urls.set(key, objectUrl);
    return objectUrl;
  }

  list(extension: string): string[] {
    const ext = extension.toLowerCase();
    return [...this.files.keys()].filter((rel) => rel.endsWith(ext)).sort();
  }

  textureFiles(): Promise<readonly IArrayBufferFile[]> {
    if (!this.textures) {
      this.textures = (async () => {
        const out: IArrayBufferFile[] = [];
        for (const [rel, file] of this.files) {
          const ext = extOf(rel);
          if (!TEXTURE_EXTS.has(ext)) continue;
          out.push({ relativePath: rel, mimeType: MIME[ext], data: await file.arrayBuffer() });
        }
        return out;
      })();
    }
    return this.textures;
  }
}

declare global {
  interface Window {
    showDirectoryPicker?(options?: {
      id?: string;
      mode?: "read" | "readwrite";
    }): Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
  }
}
