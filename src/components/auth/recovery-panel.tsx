"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export type RecoveryMode = "reset-request" | "verification-request" | "reset-password" | "verify-email";
const headings = { "reset-request": "Reset your password.", "verification-request": "Verify your email.", "reset-password": "Choose a new password.", "verify-email": "Confirm your email." };

export function RecoveryPanel({ mode, enabled, live = false }: Readonly<{ mode: RecoveryMode; enabled: boolean; live?: boolean }>) {
  const completion = mode === "reset-password" || mode === "verify-email";
  const endpoint = live ? ({ "reset-request": "password-reset-requests", "verification-request": "verification-requests",
    "reset-password": "reset-password", "verify-email": "verify-email" } as const)[mode] : mode;
  const token = useRef("");
  const pending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!completion) return;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    // React development Strict Mode repeats effects after the URL is scrubbed.
    // Keep the first captured credential in memory during that second pass.
    if (fragment.has("token")) token.current = fragment.get("token") ?? "";
    // Clear all fragment/query content before any challenge/network operation.
    window.history.replaceState(null, "", window.location.pathname);
    const receiveLink = () => {
      const incoming = new URLSearchParams(window.location.hash.slice(1));
      // Same-document navigation can emit popstate and hashchange. The first
      // event scrubs the URL; the second must not erase its captured token.
      if (!incoming.has("token")) return;
      token.current = incoming.get("token") ?? "";
      window.history.replaceState(null, "", window.location.pathname);
      setDone(false); setError(""); setNotice("");
    };
    window.addEventListener("hashchange", receiveLink);
    window.addEventListener("popstate", receiveLink);
    return () => {
      window.removeEventListener("hashchange", receiveLink);
      window.removeEventListener("popstate", receiveLink);
    };
  }, [completion]);

  async function act(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enabled || pending.current) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    pending.current = true; setBusy(true); setError(""); setNotice("");
    let failed = false;
    try {
      if (completion && !/^[A-Za-z0-9_-]{43}$/.test(token.current)) throw new Error("This link is invalid or expired. Request a new link.");
      if (mode === "reset-password" && fields.get("password") !== fields.get("confirmation")) throw new Error("The passwords do not match.");
      const challenge = await fetch(`/api/v1/auth/${live ? "recovery-challenge" : "challenge"}?purpose=${mode}`, { cache: "no-store" });
      if (!challenge.ok) throw new Error("Recovery is unavailable. Please try again later.");
      const csrf = (await challenge.json()).data.csrfToken;
      const body = completion ? { token: token.current, ...(mode === "reset-password" ? { password: fields.get("password") } : {}) } : { email: fields.get("email") };
      const response = await fetch(`/api/v1/auth/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(body) });
      if (response.status === 429) {
        const seconds = Number(response.headers.get("Retry-After"));
        throw new Error(Number.isSafeInteger(seconds) && seconds > 0 ? `Too many attempts. Try again in ${seconds} seconds.` : "Too many attempts. Try again later.");
      }
      if (response.status === 422) throw new Error("Choose a different password that meets the requirements.");
      if (response.status === 400) throw new Error("This link is invalid or expired. Request a new link.");
      if (response.status === 403) throw new Error("Your security check changed or expired. Please try again.");
      if (!response.ok) throw new Error("Recovery is unavailable. Please try again later.");
      form.reset(); setDone(true);
      if (completion) token.current = "";
      setNotice(completion ? (mode === "reset-password" ? "Your password has been reset. Sign in with your new password." : "Your email has been verified. You can now sign in.")
        : live ? "Your request has been received. If your account is eligible, you may receive a link." : "If the account is eligible, a link will be delivered. Check your delivery channel.");
    } catch (cause) {
      failed = true;
      setError(cause instanceof Error && cause.name === "Error" ? cause.message : "Could not connect. Check your connection and try again.");
      for (const name of ["password", "confirmation"]) {
        const input = form.elements.namedItem(name);
        if (input instanceof HTMLInputElement) input.value = "";
      }
    } finally {
      pending.current = false; setBusy(false);
      requestAnimationFrame(() => failed ? feedback.current?.focus() : heading.current?.focus());
    }
  }

  return <section className="auth-card" aria-labelledby="recovery-heading">
    <p className="eyebrow">Account access</p>
    <h1 id="recovery-heading" ref={heading} tabIndex={-1}>{headings[mode]}</h1>
    {!enabled ? <p role="status">Online recovery and email verification are not available yet. Contact your library for account help.</p> : <>
      <p className="auth-description">{completion ? "Use the secure link delivered for your account." : "Enter your account email to request a secure link."}</p>
      <p role="status">{busy ? "Please wait…" : notice}</p>
      <p ref={feedback} role="alert" tabIndex={-1} className={error ? "auth-error" : undefined}>{error}</p>
      {!done && <form method="post" action={`/api/v1/auth/${endpoint}`} onSubmit={(event) => { void act(event); }} aria-busy={busy}>
        <fieldset disabled={busy} className="auth-fields">
          {!completion && <><label htmlFor="recovery-email">Email address</label><input id="recovery-email" name="email" type="email" required autoComplete="email" maxLength={254} autoCapitalize="none" spellCheck={false} /></>}
          {mode === "reset-password" && <>
            <p id="password-rules">Use 15–128 characters. Spaces and Unicode are welcome. Avoid common passwords, your account name and LibraryOS.</p>
            <label htmlFor="new-password">New password</label><input id="new-password" name="password" type="password" required autoComplete="new-password" aria-describedby="password-rules" />
            <label htmlFor="confirm-password">Confirm new password</label><input id="confirm-password" name="confirmation" type="password" required autoComplete="new-password" />
          </>}
          <Button type="submit">{busy ? "Please wait…" : completion ? (mode === "verify-email" ? "Verify email" : "Set new password") : "Request a link"}</Button>
        </fieldset>
      </form>}
    </>}
    {completion && enabled && !done && <p className="auth-help"><Link href={mode === "verify-email" ? "/request-verification" : "/forgot-password"} className="text-link">Request a new link</Link></p>}
    <p className="auth-help"><Link href="/login" className="text-link">Back to sign in</Link></p>
  </section>;
}
