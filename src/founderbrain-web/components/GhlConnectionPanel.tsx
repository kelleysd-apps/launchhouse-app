import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  GhlBookingLink,
  GhlBookingLinkInput,
  GhlBookingLinkKey,
  GhlBookingLinkResult,
  GhlBookingLinks,
  GhlConnectionStatus,
} from "../../founderbrain-shared/ghl";

export function ghlDestinationLabel(connection: GhlConnectionStatus | null): string {
  if (!connection?.connected) return "GoHighLevel subaccount";
  return (
    connection.locationName?.trim() || connection.locationId?.trim() || "GoHighLevel subaccount"
  );
}

export function isVerifiedGhlIdentity(connection: GhlConnectionStatus | null): boolean {
  return Boolean(connection?.connected && connection.connectionId && connection.locationId);
}

export function normalizeHttpsBookingUrl(value: string): string | null {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password)
      return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function bookingLinkTransferExpectation(
  remoteValue: string | null,
  intendedUrl: string,
): { expectedValue: string | null; replacementRequired: boolean } {
  return {
    expectedValue: remoteValue,
    replacementRequired: remoteValue !== null && remoteValue !== "" && remoteValue !== intendedUrl,
  };
}

type LinkReceipt = {
  kind: "verified" | "unverified" | "error";
  text: string;
};

export function GhlConnectionPanel({
  connection,
  statusVerified,
  statusLoading,
  statusError,
  connecting,
  disconnecting,
  connectEnabled,
  generation,
  bookingLinks,
  bookingLoading,
  bookingError,
  linkSavingKey,
  onRefresh,
  onConnect,
  onDisconnect,
  onLoadBookingLinks,
  onSaveBookingLink,
}: {
  connection: GhlConnectionStatus | null;
  statusVerified: boolean;
  statusLoading: boolean;
  statusError: string;
  connecting: boolean;
  disconnecting: boolean;
  connectEnabled: boolean;
  generation: number;
  bookingLinks: GhlBookingLinks | null;
  bookingLoading: boolean;
  bookingError: string;
  linkSavingKey: GhlBookingLinkKey | null;
  onRefresh: () => void | Promise<void>;
  onConnect: () => void | Promise<void>;
  onDisconnect: () => Promise<boolean>;
  onLoadBookingLinks: () => void | Promise<void>;
  onSaveBookingLink: (
    input: Omit<GhlBookingLinkInput, "connectionId">,
  ) => Promise<GhlBookingLinkResult | null>;
}) {
  const verified = statusVerified && isVerifiedGhlIdentity(connection);
  const destination = ghlDestinationLabel(connection);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnectedHere, setDisconnectedHere] = useState(false);
  const [values, setValues] = useState<Partial<Record<GhlBookingLinkKey, string>>>({});
  const [replaceKey, setReplaceKey] = useState<GhlBookingLinkKey | null>(null);
  const [receipts, setReceipts] = useState<Partial<Record<GhlBookingLinkKey, LinkReceipt>>>({});
  const saveLocks = useRef<Partial<Record<GhlBookingLinkKey, symbol>>>({});

  useEffect(() => {
    setConfirmDisconnect(false);
    setValues({});
    setReplaceKey(null);
    setReceipts({});
    saveLocks.current = {};
  }, [generation]);

  useEffect(() => {
    if (verified && !bookingLinks && !bookingLoading && !bookingError) void onLoadBookingLinks();
  }, [verified, bookingLinks, bookingLoading, bookingError, generation]);

  const links = useMemo(() => bookingLinks?.links ?? [], [bookingLinks]);

  async function transfer(link: GhlBookingLink, replaceExisting: boolean) {
    if (saveLocks.current[link.key]) return;
    const normalized = normalizeHttpsBookingUrl(values[link.key] ?? "");
    if (!normalized) {
      setReceipts((current) => ({
        ...current,
        [link.key]: { kind: "error", text: "Enter the actual HTTPS booking URL." },
      }));
      return;
    }
    const expectation = bookingLinkTransferExpectation(link.value, normalized);
    if (expectation.replacementRequired && !replaceExisting) {
      setReplaceKey(link.key);
      return;
    }
    const operation = Symbol(`ghl-link-${link.key}`);
    saveLocks.current[link.key] = operation;
    setReceipts((current) => ({ ...current, [link.key]: undefined }));
    try {
      const result = await onSaveBookingLink({
        key: link.key,
        url: normalized,
        expectedValue: expectation.expectedValue,
        replaceExisting,
      });
      if (saveLocks.current[link.key] !== operation || !result) return;
      const exact = result.proven && result.link.value === normalized;
      setReceipts((current) => ({
        ...current,
        [link.key]: exact
          ? {
              kind: "verified",
              text: `${result.written ? "Written" : "Already matched"} and verified in ${ghlDestinationLabel(result.connection)}.`,
            }
          : {
              kind: "unverified",
              text: "GoHighLevel did not verify the exact URL. Check the current remote value and retry.",
            },
      }));
      if (exact) setReplaceKey(null);
    } catch {
      if (saveLocks.current[link.key] !== operation) return;
      setReceipts((current) => ({
        ...current,
        [link.key]: {
          kind: "error",
          text: "The booking link was not saved. Your typed URL is still here. Retry when ready.",
        },
      }));
    } finally {
      if (saveLocks.current[link.key] === operation) delete saveLocks.current[link.key];
    }
  }

  if (!connection) {
    return (
      <section className="ghl-account-card" aria-label="GoHighLevel connection">
        <p className="ghl-account-eyebrow">GoHighLevel subaccount</p>
        <h2>{statusLoading ? "Verifying connection…" : "Connection identity not verified"}</h2>
        <p>
          {statusError ||
            "FounderBrain is checking the live server connection. External writes stay disabled until the subaccount identity is verified."}
        </p>
        <button
          type="button"
          className="typeform-external"
          onClick={onRefresh}
          disabled={statusLoading}
        >
          {statusLoading ? "Checking status…" : "Refresh status"}
        </button>
      </section>
    );
  }

  if (!connection.connected) {
    return (
      <section className="ghl-account-card" aria-label="GoHighLevel connection">
        <p className="ghl-account-eyebrow">GoHighLevel subaccount</p>
        <h2>No subaccount connected</h2>
        <p>
          FounderBrain is disconnected. Your saved FounderBrain chapter and your existing
          GoHighLevel content remain in place.
        </p>
        {statusError ? (
          <p className="ghl-inline-error" role="alert">
            {statusError}
          </p>
        ) : null}
        <div className="ghl-button-row">
          <button
            type="button"
            className="typeform-external"
            onClick={onConnect}
            disabled={!connectEnabled || connecting || disconnecting || statusLoading}
          >
            {connecting
              ? "Opening GoHighLevel…"
              : disconnectedHere
                ? "Connect another subaccount"
                : "Connect GoHighLevel"}
          </button>
          <button
            type="button"
            className="typeform-back"
            onClick={onRefresh}
            disabled={statusLoading}
          >
            {statusLoading ? "Checking…" : "Refresh status"}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="ghl-account-stack" aria-label="Connected GoHighLevel subaccount">
      <div className="ghl-account-card verified">
        <p className="ghl-account-eyebrow">Connected GoHighLevel subaccount</p>
        <h2>{connection.locationName?.trim() || "Subaccount name unavailable"}</h2>
        <p className="ghl-account-id">
          Subaccount ID: <code>{connection.locationId || "not returned"}</code>
        </p>
        {connection.nameUnavailable ? (
          <p className="ghl-account-note">
            Showing the saved subaccount ID. GoHighLevel did not return a verified name.
          </p>
        ) : null}
        {!verified ? (
          <p className="ghl-inline-error" role="alert">
            The connection exists, but FounderBrain could not verify its full identity. Refresh
            status before any external write.
          </p>
        ) : null}
        {statusError ? (
          <p className="ghl-inline-error" role="alert">
            {statusError}
          </p>
        ) : null}
        <div className="ghl-button-row">
          <button
            type="button"
            className="typeform-back"
            onClick={onRefresh}
            disabled={statusLoading || disconnecting}
          >
            {statusLoading ? "Checking…" : "Refresh status"}
          </button>
          <button
            type="button"
            className="ghl-danger-button"
            onClick={() => setConfirmDisconnect(true)}
            disabled={!verified || disconnecting}
          >
            Disconnect
          </button>
        </div>
        {confirmDisconnect ? (
          <div className="ghl-confirm-box" role="group" aria-label={`Disconnect ${destination}`}>
            <strong>Disconnect FounderBrain from {destination}?</strong>
            <p>
              This only disconnects FounderBrain. It does not delete content or workflows in
              GoHighLevel.
            </p>
            <div className="ghl-button-row">
              <button
                type="button"
                className="ghl-danger-button solid"
                disabled={disconnecting || !verified}
                onClick={() => {
                  void onDisconnect()
                    .then((done) => {
                      if (done) {
                        setDisconnectedHere(true);
                        setConfirmDisconnect(false);
                      }
                    })
                    .catch(() => undefined);
                }}
              >
                {disconnecting ? "Disconnecting…" : `Disconnect ${destination}`}
              </button>
              <button
                type="button"
                className="typeform-back"
                onClick={() => setConfirmDisconnect(false)}
                disabled={disconnecting}
              >
                Keep connected
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="ghl-account-card">
        <p className="ghl-account-eyebrow">Booking links</p>
        <h2>Transfer the booking link used in your workflow</h2>
        <p>
          Enter the actual HTTPS URL. FounderBrain writes it directly to {destination}; it does not
          open or fetch the URL.
        </p>
        {bookingLoading ? <p>Loading current GoHighLevel values…</p> : null}
        {bookingError ? (
          <div>
            <p className="ghl-inline-error" role="alert">
              {bookingError}
            </p>
            <button
              type="button"
              className="typeform-back"
              onClick={onLoadBookingLinks}
              disabled={!verified || bookingLoading}
            >
              Retry booking-link check
            </button>
          </div>
        ) : null}
        {!bookingLoading && !bookingError && links.length === 0 ? (
          <p>
            No DM Booking Link or Call Booking Link field was returned. Refresh status and try
            again.
          </p>
        ) : null}
        {links.map((link) => {
          const currentValue = link.value?.trim() || "";
          const currentHref = normalizeHttpsBookingUrl(currentValue);
          const receipt = receipts[link.key];
          const replacing = replaceKey === link.key;
          return (
            <div className="ghl-booking-field" key={link.key}>
              <h3>{link.name}</h3>
              <p className="ghl-remote-value">
                Current in GoHighLevel:{" "}
                {currentValue ? (
                  currentHref ? (
                    <a href={currentHref}>{currentValue}</a>
                  ) : (
                    <code>{currentValue}</code>
                  )
                ) : (
                  <strong>Not set</strong>
                )}
              </p>
              <label className="typeform-field wide">
                <span>{link.name} HTTPS URL</span>
                <input
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  placeholder="https://"
                  value={values[link.key] ?? ""}
                  onChange={(event) => {
                    setValues((current) => ({ ...current, [link.key]: event.target.value }));
                    setReceipts((current) => ({ ...current, [link.key]: undefined }));
                    if (replaceKey === link.key) setReplaceKey(null);
                  }}
                  disabled={!verified || disconnecting}
                />
              </label>
              {replacing ? (
                <div className="ghl-confirm-box" role="group" aria-label={`Replace ${link.name}`}>
                  <strong>
                    Replace the current {link.name} in {destination}?
                  </strong>
                  <p>
                    The remote field already has a different URL. FounderBrain will only replace the
                    value shown above.
                  </p>
                  <div className="ghl-button-row">
                    <button
                      type="button"
                      className="typeform-external"
                      onClick={() => void transfer(link, true)}
                      disabled={!verified || linkSavingKey === link.key || disconnecting}
                    >
                      Confirm replacement
                    </button>
                    <button
                      type="button"
                      className="typeform-back"
                      onClick={() => setReplaceKey(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="typeform-external"
                  onClick={() => void transfer(link, false)}
                  disabled={!verified || linkSavingKey === link.key || disconnecting}
                >
                  {linkSavingKey === link.key
                    ? `Transferring ${link.name}…`
                    : `Transfer ${link.name} to ${destination}`}
                </button>
              )}
              {receipt ? (
                <p
                  className={`ghl-link-receipt ${receipt.kind}`}
                  role={receipt.kind === "verified" ? "status" : "alert"}
                >
                  {receipt.text}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
