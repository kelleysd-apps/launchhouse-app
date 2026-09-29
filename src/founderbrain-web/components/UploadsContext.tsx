/**
 * Lets any VoiceField reach the uploads API without prop-drilling through
 * OrientationFlow, MissionTypeform, and every screen in between (same
 * pattern as TypeformShell's TypeformExitContext).
 */
import { createContext, useContext } from "react";
import type { UploadItem, UploadsAi } from "../types";

export type UploadsApi = {
  enabled: boolean;
  items: UploadItem[];
  ai: UploadsAi;
  upload: (file: File, questionKey?: string) => Promise<UploadItem>;
  remove: (id: string) => Promise<void>;
};

export const UploadsContext = createContext<UploadsApi | null>(null);

export function useUploads(): UploadsApi | null {
  return useContext(UploadsContext);
}
