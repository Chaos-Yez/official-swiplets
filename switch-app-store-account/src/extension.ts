import * as accessibility from "@swipt/api/accessibility";
import type {
  AccessibilityElement,
  AccessibilitySelector,
  AccessibilitySnapshot,
} from "@swipt/api/accessibility";
import * as device from "@swipt/api/device";
import * as input from "@swipt/api/input";
import type { Rect } from "@swipt/api";
import { waitForChange, waitForStable } from "@swipt/api/screen";
import { defineAction, defineExtension, type Schema } from "@swipt/api/swiplet";

import { readAccounts, type Account } from "./storage";

const app = "com.apple.Preferences";
type Screen = { width: number; height: number };

const tapTimeoutMs = 3_000;
const backButtonInset = 42;
const signOutButtonWidth = 140;
const sheetRetryMs = 800;
// Measured on iOS 27.2 (24B115): an alert takes taps from 450 to 460 ms after the tap that presents it, however its
// pixels move, and the sign-out button takes them 100 ms after the row tap, while its title still slides in.
const alertPresentMs = 500;

type SwitchResult = "signedIn" | "needsAttention";

const jsonSchema = {
  type: ["object", "null"],
  properties: {
    email: {
      type: "string",
      description:
        "The Apple Account to sign in with; the iCloud account when it is missing.",
    },
    password: {
      type: "string",
      description: "The password; the saved one when it is missing.",
    },
  },
  additionalProperties: false,
};

const account: Schema<
  { email?: string; password?: string } | null | undefined,
  { email: string; password?: string } | null
> = {
  "~standard": {
    version: 1,
    vendor: "switch-app-store-account",
    validate(value) {
      if (value === undefined || value === null) {
        return { value: null };
      }
      if (typeof value !== "object" || Array.isArray(value)) {
        return {
          issues: [{ message: "expected an object with email and password" }],
        };
      }
      const { email, password, ...rest } = value as Record<string, unknown>;
      const extra = Object.keys(rest);
      if (extra.length > 0) {
        return {
          issues: extra.map((key) => ({
            message: "unknown property",
            path: [key],
          })),
        };
      }
      if (email === undefined || email === "") {
        return { value: null };
      }
      if (typeof email !== "string") {
        return { issues: [{ message: "expected a string", path: ["email"] }] };
      }
      if (password === undefined || password === "") {
        return { value: { email } };
      }
      if (typeof password !== "string") {
        return {
          issues: [{ message: "expected a string", path: ["password"] }],
        };
      }
      return { value: { email, password } };
    },
    jsonSchema: {
      input: () => jsonSchema,
      output: () => jsonSchema,
    },
  },
};

const results = ["signedIn", "needsAttention"];

const result: Schema<SwitchResult> = {
  "~standard": {
    version: 1,
    vendor: "switch-app-store-account",
    validate: (value) =>
      results.includes(value as string)
        ? { value: value as SwitchResult }
        : { issues: [{ message: `expected ${results.join(" or ")}` }] },
    jsonSchema: {
      input: () => ({ type: "string", enum: results }),
      output: () => ({ type: "string", enum: results }),
    },
  },
};

const snapshot = async (signal: AbortSignal) => {
  const taken = await accessibility.snapshot({ scope: "frontApp", signal });
  return taken.app === app ? taken : null;
};

const first = (
  scope: AccessibilitySnapshot | AccessibilityElement,
  selector: AccessibilitySelector,
) => scope.findAll(selector)[0] ?? null;

const storeRow = { identifier: "STORE_SERVICE" };
const buttonSheet = { role: "sheet", has: { role: "button" } };

// The iCloud password prompt is a secure field outside the sign-in form, under a navigation bar holding only its close
// button.
const passwordPrompt = (screen: AccessibilitySnapshot) => {
  if (
    first(screen, { identifier: "sign-in-nav-bar" }) ||
    !first(screen, { role: "secureTextField" })
  ) {
    return null;
  }
  const bar = screen
    .findAll({ role: "navigationBar" })
    .find((it) => !first(it, { identifier: "BackButton" }));
  return bar ? first(bar, { role: "button" }) : null;
};

const accountPage = (screen: AccessibilitySnapshot) => {
  const row = first(screen, storeRow);
  return row && !first(row, { role: "activityIndicator" }) ? row : null;
};

// A sheet takes taps only once its presentation has ended, later than its last visible change.
const tapPresented = async (
  element: AccessibilityElement,
  bounds: Screen,
  signal: AbortSignal,
) => {
  if (element.frame !== undefined) {
    const [x, y, width, height] = element.frame;
    const left = Math.max(0, x);
    const top = Math.max(0, y);
    const region: Rect = [
      left,
      top,
      Math.min(bounds.width, x + width) - left,
      Math.min(bounds.height, y + height) - top,
    ];
    if (region[2] > 0 && region[3] > 0) {
      await waitForStable({
        region,
        durationMs: 250,
        timeoutMs: 1_500,
        signal,
      }).catch((error: Error) => {
        if (error.name !== "TimeoutError") {
          throw error;
        }
      });
    }
  }
  await accessibility.tap(element, { timeoutMs: tapTimeoutMs, signal });
};

const tapAlertButton = async (
  index: number,
  presentedAt: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> => {
  const button = await accessibility.find(
    { app, role: "button", within: { role: "sheet" }, index },
    { timeoutMs, poll: true, signal },
  );
  if (button === null) {
    return false;
  }
  await sleep(presentedAt + alertPresentMs - Date.now(), { signal });
  await input.tap(button.point!, { signal });
  return true;
};

// Settings answers accessibility reads up to 1.3 s late while the account page loads (iOS 27.2 24B115). Its sign-out
// button sits in the navigation bar, mirroring the back button.
async function signOutOnOpen(bar: Rect, signal: AbortSignal): Promise<boolean> {
  const [x, y, width, height] = bar;
  try {
    await waitForChange({
      region: [x + width - signOutButtonWidth, y, signOutButtonWidth, height],
      timeoutMs: 2_000,
      signal,
    });
    const presentedAt = Date.now();
    await input.tap([x + width - backButtonInset, y + height / 2], { signal });
    return tapAlertButton(1, presentedAt, 3_000, signal);
  } catch (error) {
    if (signal.aborted || (error as Error).name !== "TimeoutError") {
      throw error;
    }
    return false;
  }
}

async function chooseAccount(
  other: Account | null,
  bounds: Screen,
  signal: AbortSignal,
): Promise<string | undefined> {
  const deadline = Date.now() + 90_000;
  const done = new Map<string, number>();
  const fresh = (step: string, interval = 2_000) => {
    if (Date.now() - (done.get(step) ?? 0) < interval) {
      return false;
    }
    done.set(step, Date.now());
    return true;
  };
  let signedOut: string | undefined;
  // After signing out, the account page stays, sign-out button included, until it has finished loading.
  let confirmed = false;
  let chosen = false;
  let bottom: string | undefined;
  while (Date.now() < deadline) {
    const screen = await snapshot(signal);
    if (screen === null) {
      await sleep(300, { signal });
      continue;
    }
    // The iCloud password prompt may open over anything here, the sheets included; the flow resumes once it is closed.
    const prompt = passwordPrompt(screen);
    if (prompt) {
      if (fresh("prompt", sheetRetryMs)) {
        await tapPresented(prompt, bounds, signal);
      }
      continue;
    }
    const sheet = first(screen, buttonSheet)?.findAll({ role: "button" }) ?? [];
    // Continue, Not <name>? and Cancel, in that order.
    if (sheet.length === 3) {
      if (fresh("choose", sheetRetryMs)) {
        await tapPresented(sheet[other === null ? 0 : 1], bounds, signal);
        chosen = true;
      }
      continue;
    }
    if (chosen) {
      return signedOut;
    }
    // Cancel and Sign Out, in that order.
    if (sheet.length === 2) {
      if (fresh("confirm", sheetRetryMs)) {
        await tapPresented(sheet[1], bounds, signal);
        confirmed = true;
      }
      continue;
    }
    const row = accountPage(screen);
    if (row) {
      confirmed = false;
      if (fresh("row")) {
        signedOut = row.label;
        bottom = undefined;
        // Subscriptions shows only while Media & Purchases is signed in.
        const signedIn =
          first(screen, { identifier: "SUBSCRIPTIONS" }) !== null;
        const bar = first(screen, { role: "navigationBar" })?.frame;
        const presentedAt = Date.now();
        await input.tap(row.point!, { signal });
        if (signedIn) {
          if (bar && (await signOutOnOpen(bar, signal))) {
            confirmed = true;
            done.set("confirm", Date.now());
            done.delete("row");
          }
        } else if (
          await tapAlertButton(
            other === null ? 0 : 1,
            presentedAt,
            3_000,
            signal,
          )
        ) {
          chosen = true;
          done.set("choose", Date.now());
        }
      }
      continue;
    }
    if (confirmed) {
      continue;
    }
    // The sign-out button sits in the navigation bar while the account page loads, and ends the page once it has
    // loaded.
    const signOut = first(screen, {
      role: "button",
      within: { role: "navigationBar" },
      not: { identifier: "BackButton" },
    });
    if (signOut) {
      if (fresh("signOut")) {
        const presentedAt = Date.now();
        await input.tap(signOut.point!, { signal });
        if (await tapAlertButton(1, presentedAt, 3_000, signal)) {
          confirmed = true;
          done.delete("row");
        }
      }
      continue;
    }
    const page = screen
      .findAll({ role: "button", traits: ["webContent"] })
      .at(-1);
    if (page) {
      const end = [page.label, JSON.stringify(page.frame)].join();
      if (end === bottom) {
        if (fresh("signOut")) {
          await input.tap(page.point!, { signal });
        }
      } else {
        bottom = end;
        await input.swipe(
          [bounds.width / 2, bounds.height * 0.75],
          [bounds.width / 2, bounds.height * 0.2],
          { durationMs: 300, signal },
        );
      }
    }
  }
  throw new DOMException(
    "Media & Purchases did not offer to sign in",
    "TimeoutError",
  );
}

// The sign-in form lists its fields while it still slides in.
async function signIn(other: Account, signal: AbortSignal) {
  const username = await accessibility.find(
    { app, identifier: "username-field" },
    { timeoutMs: 10_000, poll: true, signal },
  );
  if (username === null) {
    throw new DOMException("the sign-in form did not appear", "TimeoutError");
  }
  await accessibility.setText(username, other.email, {
    timeoutMs: tapTimeoutMs,
    signal,
  });
  await input.pressKey("return", { signal });
  const password = await accessibility.find(
    { app, identifier: "password-field" },
    { timeoutMs: 30_000, signal },
  );
  if (password === null) {
    throw new DOMException(
      "the sign-in form did not ask for the password",
      "TimeoutError",
    );
  }
  await accessibility.setText(password, other.password, {
    timeoutMs: tapTimeoutMs,
    signal,
  });
  await input.pressKey("return", { signal });
}

async function finish(
  signedOut: string | undefined,
  signal: AbortSignal,
): Promise<SwitchResult> {
  const deadline = Date.now() + 120_000;
  let waiting: number | undefined;
  while (Date.now() < deadline) {
    const screen = await snapshot(signal);
    if (screen !== null) {
      const row = first(screen, storeRow);
      const busy =
        (row && first(row, { role: "activityIndicator" })) ||
        first(screen, { identifier: "SIGN_IN_SPINNER_VIEW" });
      const form = first(screen, { identifier: "sign-in-nav-bar" });
      const typing = first(screen, {
        identifier: /^(username|password)-field$/,
      });
      const prompt = passwordPrompt(screen);
      if (
        row &&
        row.label !== signedOut &&
        !busy &&
        !form &&
        !first(screen, buttonSheet) &&
        !prompt
      ) {
        return "signedIn";
      }
      const prompted =
        first(screen, buttonSheet) ||
        prompt ||
        (form &&
          !typing &&
          !first(screen, { identifier: "SIGN_IN_SPINNER_VIEW" }));
      waiting = prompted ? (waiting ?? Date.now()) : undefined;
      if (waiting !== undefined && Date.now() - waiting > 3_000) {
        return "needsAttention";
      }
    } else {
      await sleep(300, { signal });
    }
  }
  return "needsAttention";
}

export default defineExtension({
  actions: {
    switchAccount: defineAction({
      title: "Switch App Store Account",
      description:
        "Signs Media & Purchases out and back in, with the iCloud account when the input has no email, or with the email and its given or saved password.",
      input: account,
      output: result,
      expose: ["shortcuts"],
      async run(given, { signal }) {
        let other: Account | null = null;
        if (given !== null) {
          const password =
            given.password ??
            (await readAccounts()).find(
              (it) => it.email.toLowerCase() === given.email.toLowerCase(),
            )?.password;
          if (password === undefined) {
            throw new Error(`no password is saved for ${given.email}`);
          }
          other = { email: given.email, password };
        }
        const { screen: bounds } = await device.info({ signal });
        await device.launchApplication(app, { restart: true, signal });
        const primary = await accessibility.find(
          { app, identifier: "com.apple.settings.primaryAppleAccount" },
          { timeoutMs: 10_000, poll: true, signal },
        );
        if (primary === null) {
          throw new DOMException(
            "Settings did not show the Apple Account",
            "TimeoutError",
          );
        }
        await input.tap(primary.point!, { signal });
        const signedOut = await chooseAccount(other, bounds, signal);
        if (other !== null) {
          await signIn(other, signal);
        }
        return finish(signedOut, signal);
      },
    }),
  },
});
