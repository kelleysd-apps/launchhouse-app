/** Founder-facing CRM contracts. Never include OAuth tokens or provider secrets. */
export type GhlConnectionStatus = {
  connected: boolean;
  locationId: string | null;
  locationName: string | null;
  connectionId: string | null;
  nameUnavailable?: boolean;
};

export type GhlBookingLinkKey = "dm_booking_link" | "call_booking_link";
export type GhlBookingLink = {
  key: GhlBookingLinkKey;
  name: string;
  value: string | null;
};
export type GhlBookingLinks = {
  connection: GhlConnectionStatus;
  links: GhlBookingLink[];
};
export type GhlBookingLinkInput = {
  connectionId: string;
  key: GhlBookingLinkKey;
  url: string;
  expectedValue: string | null;
  replaceExisting: boolean;
};
export type GhlBookingLinkResult = {
  connection: GhlConnectionStatus;
  link: GhlBookingLink;
  written: boolean;
  proven: boolean;
};
export type GhlPushResult = {
  connection: GhlConnectionStatus;
  snapshot: string;
  firstPack: string;
  pushed: string[];
  skipped: string[];
  proven: boolean;
  clinicPaste: string[];
  held: Array<{ name: string; code: string; reason: string }>;
};
