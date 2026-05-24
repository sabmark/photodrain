/// <reference types="vite/client" />

import type { PhotoDrainApi } from "../../electron/preload";

declare global {
  interface Window {
    photoDrain: PhotoDrainApi;
  }
}
