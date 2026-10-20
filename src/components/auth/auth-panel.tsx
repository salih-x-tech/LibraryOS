"use client";

import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import Link from "next/link";

type State = "signed-in" | "signed-out" | "unavailable";

async function submit(purpose: "login" | "logout", body: unknown): Promise<void> {
  const challenge = await fetch(`/api/v1/auth/challenge?purpose=${purpose}`, { cache: "no-store" });
  if (!challenge.ok) throw new Error("Sign-in services are unavailable. Please try again later.");
  const token = (await challenge.json()).data.csrfToken;
  const response = await fetch(`/api/v1/auth/${purpose}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": token }, body: JSON.stringify(body),
  });
  if (response.ok) return;
  if (response.status === 401) throw new Error("Unable to sign in. Check your email and password, or contact your library for account access.");
  if (response.status === 429) {
    const seconds = Number(response.headers.get("Retry-After"));
    throw new Error(Number.isSafeInteger(seconds) && seconds > 0
      ? `Too many attempts. Try again in ${seconds} seconds.` : "Too many attempts. Please try again later.");
  }
  if (response.status === 403) throw new Error("Your security check expired or changed. Please try again.");
  if (response.status === 400 || response.status === 422) throw new Error("Check your email and password and try again.");
  throw new Error(purpose === "logout" ? "Unable to sign out. Your session has been kept. Please try again." : "Sign-in services are unavailable. Please try again later.");
}

export function AuthPanel({ initialState, hasSessionCookie }: Readonly<{ initialState: State; hasSessionCookie: boolean }>) {
  const [state, setState] = useState(initialState);
  const [hasCookie, setHasCookie] = useState(hasSessionCookie);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const feedback = useRef<HTMLParagraphElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const pending = useRef(false);

  async function act(purpose: "login" | "logout", event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    pending.current = true; setBusy(true); setError(""); setNotice("");
    let failed = false;
    try {
      await submit(purpose, purpose === "login" ? { email: fields.get("email"), password: fields.get("password") } : {});
      form.reset();
      setState(purpose === "login" ? "signed-in" : "signed-out");
      setHasCookie(purpose === "login");
      setNotice(purpose === "login" ? "You are signed in." : "You have been signed out.");
    } catch (cause) {
      failed = true;
      setError(cause instanceof Error && cause.message !== "Failed to fetch" ? cause.message : "Could not connect. Check your connection and try again.");
      // Avoid retaining the attempted password after an error.
      const password = form.elements.namedItem("password");
      if (password instanceof HTMLInputElement) password.value = "";
    } finally {
      pending.current = false; setBusy(false);
      requestAnimationFrame(() => failed ? feedback.current?.focus() : heading.current?.focus());
    }
  }

  return <section className="auth-card" aria-labelledby="auth-heading">
    <p className="eyebrow">Your next chapter</p>
    <h1 id="auth-heading" ref={heading} tabIndex={-1}>{state === "signed-in" ? "Welcome back." : "Sign in to LibraryOS."}</h1>
    <p className="auth-description">{state === "signed-in" ? "Your account is signed in. Library tools and organization setup are coming soon." : "Use your library account to continue."}</p>
    {initialState === "unavailable" && state === "unavailable" && <p role="status">We could not check your session. Try again or sign out of this browser.</p>}
    <p className="auth-notice" role="status">{busy ? "Please wait…" : notice}</p>
    <p ref={feedback} tabIndex={-1} role="alert" className={error ? "auth-error" : undefined}>{error}</p>
    {state !== "signed-in" && <form method="post" action="/api/v1/auth/login" onSubmit={(event) => { void act("login", event); }} aria-busy={busy}>
      <fieldset disabled={busy} className="auth-fields">
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={254} />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required aria-describedby="account-help" />
        <Button type="submit">{busy ? "Please wait…" : "Sign in"}</Button>
      </fieldset>
    </form>}
    {hasCookie && <form method="post" action="/api/v1/auth/logout" onSubmit={(event) => { void act("logout", event); }} aria-busy={busy}>
      <Button type="submit" variant="outline" disabled={busy}>{state === "signed-in" ? "Sign out" : "Sign out of this browser"}</Button>
    </form>}
    <p id="account-help" className="auth-help">Need account access or password help? Contact your library. Online registration and password recovery are not available yet.</p>
    <Link href="/" className="text-link">Back to the workspace preview</Link>
  </section>;
}
