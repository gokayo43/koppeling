import { expect, test } from "bun:test";

import { sharedCookieDomain } from "~/cookie-domain.ts";

// The deployed shape, and the bug it stands against: a session cookie the API
// set under its own hostname, which the web app on the parent never receives —
// sign-in succeeds and the browser still looks signed out.
test("the deployed pair share the cookie on the hostname the web app is on", () => {
  expect(sharedCookieDomain("https://shop.example.com", "https://api.shop.example.com")).toBe(
    "shop.example.com",
  );
});

// A preview: one host, two ports. Cookies ignore the port, so there is nothing
// to widen — and "127.0.0.1" as a Domain is a cookie the browser drops.
test("a preview's two ports are already one host", () => {
  expect(sharedCookieDomain("http://127.0.0.1:5190", "http://127.0.0.1:5191")).toBeUndefined();
});

// The wrong rule this stands against is "the hostnames differ, so widen": a dev
// checkout that spells the site localhost and the API 127.0.0.1 would be handed
// Domain=localhost by a cookie set on 127.0.0.1, which is not a domain that
// host may name, and the session would be dropped on the way in.
test("a developer's two spellings of this machine get no domain", () => {
  expect(sharedCookieDomain("http://localhost:5180", "http://127.0.0.1:3001")).toBeUndefined();
});

// And nesting does not turn a loopback pair into a topology: `api.localhost`
// sits under `localhost` by the same test the deployed pair passes, but the
// machine is still this one and the browser is not going to share a cookie
// across it. A rule that reads nesting first answers "localhost" here.
test("a loopback pair gets nothing even when the two names nest", () => {
  expect(sharedCookieDomain("http://localhost:5180", "http://api.localhost:3001")).toBeUndefined();
});

// And the wrong rule "the API's host ends with the site's": `notexample.com`
// ends with `example.com` and sits under nothing, so a suffix test would hand
// back a Domain the browser drops on arrival. Two hostnames unrelated to each
// other is the case below, and this is one of its spellings.
test("a hostname that merely ends with the site's is not under it", () => {
  expect(() => sharedCookieDomain("https://example.com", "https://notexample.com")).toThrow(
    /no cookie can reach both/,
  );
});

// Undefined and refused are different answers, and only one of them is safe to
// return. A site moved to `www.` in front of the same `api.` is outside the one
// topology infra/nginx serves, so the program says so at boot instead of
// serving sign-ins that leave the browser signed out.
test("a pair outside the topology nginx serves stops the program", () => {
  expect(() => sharedCookieDomain("https://www.shop.com", "https://api.shop.com")).toThrow(
    /no cookie can reach both https:\/\/www\.shop\.com and https:\/\/api\.shop\.com/,
  );
});

// `127.example.com` is a domain somebody owns, not this machine — a prefix test
// on "127." reads it as loopback and answers undefined for a deployed pair,
// which is a session the web app never sees.
test("a hostname that merely starts like a loopback address is not one", () => {
  expect(sharedCookieDomain("https://127.example.com", "https://api.127.example.com")).toBe(
    "127.example.com",
  );
});

// A half-edited `.env`: the site moved to its deployed hostname and the API was
// left on this machine, or the reverse. Nothing legitimate produces it — CI, a
// preview and a worktree derive both from loopback ports, and a deployment sets
// both — so it is the operator mistake this module exists to catch, and
// answering undefined would start a program that cannot hold a session.
test("one side on this machine and the other not stops the program", () => {
  expect(() => sharedCookieDomain("https://shop.example.com", "http://127.0.0.1:3001")).toThrow(
    /not the same environment/,
  );
  expect(() => sharedCookieDomain("http://localhost:5180", "https://api.shop.example.com")).toThrow(
    /not the same environment/,
  );
});
