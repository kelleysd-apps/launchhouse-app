/**
 * Copy and screen definitions for first-login orientation and later chapters.
 * Keep inspirational, short, and free of live sessions / videos / self-host / Google Form.
 */
import type {
  ContentAnswers,
  FounderTrack,
  OrientationState,
  OutreachAnswers,
} from "../founderbrain-shared/orientation";
import {
  CONTENT_CHAPTER_SCREENS,
  GHL_CHAPTER_SCREENS,
  ORIENTATION_FIRST_LOGIN_SCREENS,
  OUTREACH_CHAPTER_SCREENS,
} from "../founderbrain-shared/orientation";

/** Official GoHighLevel pricing. Founders buy Starter; do not start the 14-day trial. */
export const GHL_STARTER_URL = "https://www.gohighlevel.com/pricing";

export type TypeformChoice = { value: string; label: string };

export type TypeformScreen = {
  id: string;
  title: string;
  body: string[];
  bullets?: string[];
  /** Choice buttons; selecting one advances with that value. */
  choices?: TypeformChoice[];
  /** Free-text field key into chapter answers. */
  textField?: {
    key: string;
    label: string;
    placeholder: string;
    hint?: string;
    multiline?: boolean;
    maxLength?: number;
  };
  /** Confirm checkbox key into chapter answers. */
  confirm?: { key: string; label: string };
  /** Opens in a new tab. Used for GoHighLevel Starter. */
  externalLink?: { href: string; label: string };
  /** This screen fetches GET /api/usage and renders the metered price table. */
  usage?: boolean;
  continueLabel?: string;
};

export const firstLoginScreens: TypeformScreen[] = [
  {
    id: "name",
    title: "Welcome... what should we call you?",
    body: [],
  },
  {
    id: "ready",
    title: "Hi X... ready to start?",
    body: [],
  },
];

export function contentScreens(track: FounderTrack | null): TypeformScreen[] {
  const trackSetup: TypeformScreen =
    track === "b2c"
      ? {
          id: "instagram",
          title: "Instagram (optional)",
          body: [
            "Not everyone uses Instagram. You do not need an account to complete this chapter.",
            "If you have a handle you plan to post from, enter it here. Otherwise, leave this blank and continue.",
          ],
          textField: {
            key: "instagramHandle",
            label: "Instagram handle",
            placeholder: "@yourhandle",
            hint: "Letters, numbers, periods, and underscores. Up to 30 characters.",
            maxLength: 64,
          },
        }
      : {
          id: "domain",
          title: "Email domain ready",
          body: [
            "For B2B founders, enter the domain you will send from.",
            "This is the domain itself, not a checkbox that it is ready.",
          ],
          textField: {
            key: "emailDomain",
            label: "Email domain",
            placeholder: "yourcompany.com",
            hint: "No @ and no https. Example: yourcompany.com",
            maxLength: 253,
          },
        };

  return [
    {
      id: "content-intro",
      title: "Voice and content",
      body: [
        "After Voice is saved, this chapter is the rest of Saturday's content work.",
        "No videos. No outside checklist. Progress lives here.",
      ],
    },
    {
      id: "track",
      title: "B2B or B2C?",
      body: ["Pick the track that matches who you sell to. We will ask one setup question next."],
      choices: [
        { value: "b2b", label: "B2B — sell to businesses" },
        { value: "b2c", label: "B2C — sell to consumers" },
      ],
    },
    trackSetup,
    {
      id: "thirty",
      title: "Thirty pieces",
      body: [
        "Generate and edit thirty content pieces in FounderBrain once Voice is in place.",
        "If a piece asks for a photo or clip, attach a saved file to that piece before you continue.",
      ],
    },
    {
      id: "bottleneck",
      title: "Name the bottleneck",
      body: ["What slows content down for you right now? One honest sentence is enough."],
      textField: {
        key: "bottleneck",
        label: "Bottleneck",
        placeholder: "e.g. Editing takes longer than writing",
      },
    },
    {
      id: "workflow",
      title: "Pick a workflow",
      body: ["Choose how you will ship content through the weekend and the ninety days after."],
      choices: [
        { value: "batch-weekly", label: "Batch weekly, publish daily" },
        { value: "daily-draft", label: "Draft daily, edit same day" },
        { value: "pair-review", label: "Pair: I draft, partner reviews" },
      ],
    },
  ];
}

export function outreachScreens(track: FounderTrack | null): TypeformScreen[] {
  const listScreen: TypeformScreen =
    track === "b2c"
      ? {
          id: "accounts",
          title: "Twenty-five target accounts",
          body: [
            "Name twenty-five accounts you will actually reach.",
            "One account per line. Duplicates count once.",
          ],
          textField: {
            key: "accounts",
            label: "Target accounts",
            placeholder: "@account or a name, one per line",
            hint: "25 lines required.",
            multiline: true,
            maxLength: 8000,
          },
        }
      : {
          id: "prospects",
          title: "Prospect list",
          body: [
            "Enter the people you will contact on Saturday.",
            "One person per line, with a name and an email.",
          ],
          textField: {
            key: "prospects",
            label: "Prospects",
            placeholder: "Ada Lovelace <ada@example.com>",
            hint: "At least 5. Each line needs a name and an email.",
            multiline: true,
            maxLength: 8000,
          },
        };

  return [
    {
      id: "outreach-intro",
      title: "Outreach copy",
      body: [
        "Write the outreach copy you will actually send.",
        "Apollo stays weekend work for B2B. GoHighLevel has its own chapter. Nothing is sent from here.",
      ],
      textField: {
        key: "copy",
        label: "Outreach copy",
        placeholder: "The message you will send, in your own words.",
        hint: "At least a short paragraph. This is saved. A checkbox does not count.",
        multiline: true,
        maxLength: 8000,
      },
    },
    listScreen,
    {
      id: "outreach-done",
      title: "Outreach chapter complete",
      body: [
        "You have the Saturday outreach artifacts in FounderBrain.",
        "Check Atlanta-ready on Home to see what is still partial.",
      ],
      continueLabel: "Back to Home",
    },
  ];
}

export function ghlScreens(hasAccount: boolean | undefined): TypeformScreen[] {
  const buyOrSkip: TypeformScreen =
    hasAccount === true
      ? {
          id: "ghl-ready",
          title: "You already have GoHighLevel.",
          body: [
            "Good. You do not need another account.",
            "Next step is Connect. One click, on your sub-account.",
          ],
        }
      : {
          id: "ghl-buy",
          title: "Buy Starter.",
          body: [
            "Open GoHighLevel pricing in a new tab. Buy the Starter plan at $97 a month.",
            "Do not start the 14-day trial. A trial started now expires during Atlanta.",
          ],
          externalLink: {
            href: GHL_STARTER_URL,
            label: "Buy GoHighLevel Starter",
          },
        };

  return [
    {
      id: "ghl-need",
      title: "You need GoHighLevel.",
      body: [
        "FounderBrain writes your Brain here. GoHighLevel is where it runs: CRM, posts, automations.",
        "Claude is not part of this. You bring your own GoHighLevel account.",
      ],
    },
    {
      id: "ghl-have",
      title: "Do you already have GoHighLevel?",
      body: ["If you do, skip the purchase. If you do not, buy Starter next."],
      choices: [
        { value: "yes", label: "I already have GoHighLevel" },
        { value: "no", label: "I need to buy Starter" },
      ],
    },
    buyOrSkip,
    {
      id: "ghl-price",
      title: "Your metered price.",
      body: [
        "Nothing was charged up front. Usage is metered as it happens: AI tokens and pages read from your website.",
        "This is the final price for what this Brain actually used. It carries to GoHighLevel with the rest of your account.",
      ],
      usage: true,
    },
    {
      id: "ghl-connect",
      title: "Connect GoHighLevel",
      body: [
        "One click opens GoHighLevel. Pick your sub-account. You come back connected.",
        "Nothing is published or sent in that click. It only authorizes FounderBrain to push later.",
      ],
      continueLabel: "Back to Home",
    },
  ];
}

export const firstLoginTotal = 2;
export const contentTotal = CONTENT_CHAPTER_SCREENS;
export const outreachTotal = OUTREACH_CHAPTER_SCREENS;
export const ghlTotal = GHL_CHAPTER_SCREENS;

export function progressLabel(screen: number, total: number): string {
  return `${screen} of ${total}`;
}

/** Dropped prep-guide delivery that must never appear in chapter copy. */
export const DROPPED_PREP_DELIVERY = [
  "live 90-minute",
  "session recording",
  "scribe",
  "youtube",
  "github import",
  "replit",
  "claude api",
  "google form",
  "watch then build",
  "self-host",
] as const;

export function chapterCopyCorpus(): string {
  const screens = [
    ...firstLoginScreens,
    ...contentScreens("b2b"),
    ...contentScreens("b2c"),
    ...outreachScreens("b2b"),
    ...outreachScreens("b2c"),
    ...ghlScreens(true),
    ...ghlScreens(false),
  ];
  return screens
    .flatMap((s) => [s.title, ...s.body, ...(s.bullets ?? []), s.continueLabel ?? ""])
    .join("\n")
    .toLowerCase();
}

export type ChapterKind = "first-login" | "content" | "outreach" | "ghl";

export function mergeContentAnswers(
  current: ContentAnswers,
  patch: Partial<ContentAnswers>,
): ContentAnswers {
  return { ...current, ...patch };
}

export function mergeOutreachAnswers(
  current: OutreachAnswers,
  patch: Partial<OutreachAnswers>,
): OutreachAnswers {
  return { ...current, ...patch };
}

export function orientationResumeScreen(state: OrientationState): number {
  if (state.firstLoginCompletedAt) return ORIENTATION_FIRST_LOGIN_SCREENS;
  return state.firstLoginScreen;
}
