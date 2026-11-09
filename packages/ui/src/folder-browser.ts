import { execute } from './api';
import type { Asset } from './model';

export interface FolderFile {
  name: string;
  path: string;
  size: number;
}
export interface FolderListing {
  folder: string;
  index: number | null;
  files: FolderFile[];
}

/**
 * A folder opened from a file: its images are listed by name only, and each one is
 * indexed (`file.open`) when the viewer reaches it, never the whole folder at once.
 */
export class FolderBrowser {
  readonly ids: string[];
  private readonly byPath = new Map<string, string>();
  private readonly pending = new Map<string, Promise<Asset>>();
  constructor(
    readonly listing: FolderListing,
    startId: string,
  ) {
    // Unopened files carry a placeholder id until they are resolved.
    this.ids = listing.files.map((file, position) =>
      position === listing.index ? startId : FolderBrowser.placeholder(file.path),
    );
    if (listing.index !== null) this.byPath.set(listing.files[listing.index].path, startId);
  }
  static placeholder(path: string) {
    return `file:${path}`;
  }
  static isPlaceholder(id: string) {
    return id.startsWith('file:');
  }
  get folderName() {
    return this.listing.folder.split(/[\\/]/).filter(Boolean).at(-1) || this.listing.folder;
  }
  /** Opens the file at a placeholder id and returns its catalog asset. */
  resolve(id: string): Promise<Asset> {
    const path = id.slice('file:'.length);
    let request = this.pending.get(path);
    if (!request) {
      request = execute<Asset>('file.open', { path });
      this.pending.set(path, request);
      request.then(
        (asset) => {
          this.byPath.set(path, asset.id);
          const at = this.ids.indexOf(id);
          if (at >= 0) this.ids[at] = asset.id;
        },
        () => this.pending.delete(path),
      );
    }
    return request;
  }
  nameOf(id: string) {
    if (FolderBrowser.isPlaceholder(id))
      return this.listing.files.find((file) => file.path === id.slice(5))?.name ?? '';
    for (const [path, known] of this.byPath)
      if (known === id) return this.listing.files.find((file) => file.path === path)?.name ?? '';
    return '';
  }
}

export async function listFolder(path: string): Promise<FolderListing | undefined> {
  try {
    const listing = await execute<FolderListing>('file.siblings', { path });
    return listing.files.length > 1 && listing.index !== null ? listing : undefined;
  } catch {
    return undefined;
  }
}
