/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  bookingLinkTransferExpectation,
  GhlConnectionPanel,
  normalizeHttpsBookingUrl,
} from "../components/GhlConnectionPanel.tsx";

const noop = () => undefined;
const disconnect = async () => true;
const saveLink = async () => null;

test("connected account panel renders the real subaccount identity and booking-link control", () => {
  const html = renderToStaticMarkup(
    createElement(GhlConnectionPanel, {
      connection: {
        connected: true,
        locationId: "loc_42",
        locationName: "Northside Wellness",
        connectionId: "conn_9",
      },
      statusVerified: true,
      statusLoading: false,
      statusError: "",
      connecting: false,
      disconnecting: false,
      connectEnabled: true,
      generation: 3,
      bookingLinks: {
        connection: {
          connected: true,
          locationId: "loc_42",
          locationName: "Northside Wellness",
          connectionId: "conn_9",
        },
        links: [
          {
            key: "dm_booking_link",
            name: "DM Booking Link",
            value: "https://book.example.com/current",
          },
        ],
      },
      bookingLoading: false,
      bookingError: "",
      linkSavingKey: null,
      onRefresh: noop,
      onConnect: noop,
      onDisconnect: disconnect,
      onLoadBookingLinks: noop,
      onSaveBookingLink: saveLink,
    }),
  );

  assert.match(html, /Northside Wellness/);
  assert.match(html, /Subaccount ID:/);
  assert.match(html, /loc_42/);
  assert.match(html, /Disconnect/);
  assert.match(html, /Current in GoHighLevel:/);
  assert.match(html, /https:\/\/book\.example\.com\/current/);
  assert.match(html, /Transfer DM Booking Link to Northside Wellness/);
  assert.doesNotMatch(html, /Paste by hand|clinic/i);
});

test("metadata failure does not render a false disconnected claim", () => {
  const html = renderToStaticMarkup(
    createElement(GhlConnectionPanel, {
      connection: null,
      statusVerified: false,
      statusLoading: false,
      statusError: "FounderBrain could not verify the connected GoHighLevel subaccount.",
      connecting: false,
      disconnecting: false,
      connectEnabled: true,
      generation: 1,
      bookingLinks: null,
      bookingLoading: false,
      bookingError: "",
      linkSavingKey: null,
      onRefresh: noop,
      onConnect: noop,
      onDisconnect: disconnect,
      onLoadBookingLinks: noop,
      onSaveBookingLink: saveLink,
    }),
  );

  assert.match(html, /Connection identity not verified/);
  assert.match(html, /Refresh status/);
  assert.doesNotMatch(html, /No subaccount connected/);
});

test("booking URL validation accepts HTTPS only without fetching", () => {
  assert.equal(
    normalizeHttpsBookingUrl("https://book.example.com/dm"),
    "https://book.example.com/dm",
  );
  assert.equal(normalizeHttpsBookingUrl("http://book.example.com/dm"), null);
  assert.equal(normalizeHttpsBookingUrl("https://user:pass@book.example.com/dm"), null);
  assert.equal(normalizeHttpsBookingUrl("not a url"), null);
});

test("a failed refresh keeps the last known name visible but disables external writes", () => {
  const html = renderToStaticMarkup(
    createElement(GhlConnectionPanel, {
      connection: {
        connected: true,
        locationId: "loc_42",
        locationName: "Northside Wellness",
        connectionId: "conn_9",
      },
      statusVerified: false,
      statusLoading: false,
      statusError: "Live connection identity could not be verified.",
      connecting: false,
      disconnecting: false,
      connectEnabled: true,
      generation: 4,
      bookingLinks: null,
      bookingLoading: false,
      bookingError: "",
      linkSavingKey: null,
      onRefresh: noop,
      onConnect: noop,
      onDisconnect: disconnect,
      onLoadBookingLinks: noop,
      onSaveBookingLink: saveLink,
    }),
  );

  assert.match(html, /Northside Wellness/);
  assert.match(html, /Live connection identity could not be verified/);
  assert.match(html, /Refresh status before any external write/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Disconnect<\/button>/);
  assert.doesNotMatch(html, /No subaccount connected/);
});

test("booking-link replacement preserves the exact remote value for optimistic comparison", () => {
  assert.deepEqual(
    bookingLinkTransferExpectation(
      "  https://book.example.com/old  ",
      "https://book.example.com/new",
    ),
    {
      expectedValue: "  https://book.example.com/old  ",
      replacementRequired: true,
    },
  );
  assert.deepEqual(bookingLinkTransferExpectation("   ", "https://book.example.com/new"), {
    expectedValue: "   ",
    replacementRequired: true,
  });
  assert.deepEqual(bookingLinkTransferExpectation(null, "https://book.example.com/new"), {
    expectedValue: null,
    replacementRequired: false,
  });
});
