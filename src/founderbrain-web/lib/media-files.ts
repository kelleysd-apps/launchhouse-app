/**
 * Pure helper for the Files screen: splits Danny's media list (content photos,
 * videos, Instagram media, and Higgsfield generations) into the two groups
 * shown there. Every item is kept, including pending and failed ones, so the
 * Files screen matches the content library; the screen itself decides what a
 * non-ready item can do (no Open link until it's ready).
 */
import type { MediaItem } from "../types";

export type MediaFilesSplit = {
  /** Founder-uploaded and Instagram photos/videos -- listed under "Uploaded by you". */
  uploaded: MediaItem[];
  /** Higgsfield-generated photos/videos -- listed under "Created by FounderBrain". */
  created: MediaItem[];
};

export function splitMediaForFiles(items: MediaItem[]): MediaFilesSplit {
  return {
    uploaded: items.filter((item) => item.source === "upload" || item.source === "instagram"),
    created: items.filter((item) => item.source === "higgsfield"),
  };
}
