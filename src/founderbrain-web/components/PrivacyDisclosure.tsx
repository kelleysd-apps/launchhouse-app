/**
 * In-app privacy / data-use / deletion disclosure (#27).
 * Linked from sign-in and the workspace delete zone. House style: short sentences, no em dashes.
 * Consent model: consent is given by using the app; this page is the standing notice.
 */
const EFFECTIVE = "2026-09-26";

export function PrivacyDisclosure({ onBack }: { onBack: () => void }) {
  return (
    <article className="privacy-card" aria-labelledby="privacy-title">
      <p className="eyebrow">PRIVACY AND DATA USE</p>
      <h1 id="privacy-title">The whole disclosure. One page.</h1>
      <p className="meta">
        Effective {EFFECTIVE}. Material changes appear on this page with a new date. Continued use
        after a change means you accept it.
      </p>

      <section>
        <h2>Consent</h2>
        <ul>
          <li>
            You accept this page by creating a workspace and by using the app. There is no separate
            signup contract.
          </li>
          <li>If you cannot accept this page, do not use FounderBrain.</li>
        </ul>
      </section>

      <section>
        <h2>What is stored</h2>
        <ul>
          <li>
            Your Brain revisions, save receipts, workspace events, and generated artifacts, stored
            encrypted in private Railway PostgreSQL. Region: the one picked when your environment
            was provisioned.
          </li>
          <li>
            Files you upload are stored encrypted in your workspace, the same as the rest of your
            Brain. Nothing you upload is published or sent to your customers.
          </li>
          <li>
            The Cloudflare Worker serves the app and proxies API calls. It stores no Brain content.
          </li>
          <li>
            Hexclave holds identity only: your invite email and session. It stores no Brain content.
          </li>
          <li>No Supabase. No ads. No analytics on Brain content.</li>
        </ul>
      </section>

      <section>
        <h2>What is sent to AI</h2>
        <ul>
          <li>
            <strong>AI training is off.</strong> Every AI call is routed with zero data retention
            and data collection denied (OpenRouter <code>zdr</code>,{" "}
            <code>data_collection: deny</code>). Your prompts and outputs are not stored by the
            provider and are never used to train a model.
          </li>
          <li>
            Browsing, editing, saving, approving, exporting, and restoring send nothing to any AI
            provider.
          </li>
          <li>
            A provider (OpenRouter) is called for explicit AI actions, including Generate and the
            optional Gmail voice analysis described below, using only the relevant inputs for that
            action. Models are limited to a short allowlist reviewed for zero data retention.
          </li>
          <li>
            Optional website import sends the address you submit to Firecrawl to read that page.
            Nothing is read unless you submit a URL.
          </li>
          <li>
            Provider calls are metered: token counts and page credits are recorded to compute the
            price shown before GoHighLevel connect. Metering records are billing records, not Brain
            content, and are kept while billing requires.
          </li>
          <li>
            When you generate, the text of your uploaded files is sent to the AI provider along with
            your Brain, up to the stated per-generation limit shown on the Files screen. A file with
            no readable text, such as a scanned PDF with no text layer, is never sent. The same
            zero-retention, no-training handling above applies to that text.
          </li>
        </ul>
      </section>

      <section>
        <h2>Optional Gmail connection</h2>
        <ul>
          <li>
            Connecting Gmail is separate from signing into FounderBrain. You choose the Google
            mailbox and can disconnect it at any time. We request Gmail read and compose
            permissions, which allow reading messages, creating drafts, and sending mail. Sending is
            off by default.
          </li>
          <li>
            Voice analysis reads only sent emails you explicitly select, after separate consent to
            send those selections to our AI provider for style analysis. It does not read
            attachments. Quoted replies and signatures are filtered where recognizable. Do not
            select confidential messages or material you are not authorized to share.
          </li>
          <li>
            Raw selected email bodies are used transiently for that analysis and are not retained by
            FounderBrain. The resulting style profile and generated message bodies are encrypted in
            your workspace, along with your encrypted Google tokens. Mail identifiers, send status
            and usage counts support deduplication and limits.
          </li>
          <li>
            Drafts use your writing-style profile and the brief you provide. Saving to Gmail Drafts
            is a separate action. Manual sending requires a message preview and confirmation.
            Optional automatic sending applies only to new messages you generate, for an explicit
            recipient allowlist and daily limit. It is not an unattended inbox auto-replier.
          </li>
          <li>
            Gmail data is not sold, used for advertising, or used to develop, improve, or train
            generalized AI models. FounderBrain's use and transfer of information received from
            Google APIs adheres to the Google API Services User Data Policy, including the Limited
            Use requirements.
          </li>
          <li>
            Disconnect removes the local Gmail connection, style profile, and connector drafts, and
            attempts to revoke Google access. A failed remote revocation is reported so you can
            remove access in your Google Account. Emails or drafts already saved in Gmail remain in
            Gmail. Workspace deletion also deletes local connector records. Infrastructure backups
            expire on the operator's retention schedule.
          </li>
        </ul>
        <p>
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noopener noreferrer"
          >
            Google API Services User Data Policy
          </a>
        </p>
      </section>

      <section>
        <h2>Deletion</h2>
        <ul>
          <li>
            Delete workspace removes Brain revisions, receipts, events, membership, uploaded files,
            and related blobs immediately. It is permanent and cannot be undone from the product.
          </li>
          <li>
            Deleting a single uploaded file, or deleting your account, removes it the same way.
            Removing a file from a question's paperclip also deletes it, not just the attachment.
          </li>
          <li>
            If a generation was mid-flight at delete time, pseudonymous billing identifiers may
            remain so an operator can reconcile provider billing. Prompts and outputs are not kept
            on that path.
          </li>
          <li>
            Infrastructure backups run on an operator-defined retention window, then expire
            automatically.
          </li>
        </ul>
      </section>

      <section>
        <h2>Your controls</h2>
        <ul>
          <li>Export your Brain at any time. Delete your workspace at any time.</li>
          <li>
            For a deletion confirmation or the backup window in force for your environment, contact
            the operator who invited you. Pilot access is invite-only.
          </li>
        </ul>
      </section>

      <button className="button secondary" type="button" onClick={onBack}>
        Back
      </button>
    </article>
  );
}
