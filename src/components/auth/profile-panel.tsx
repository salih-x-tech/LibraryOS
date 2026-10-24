"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export function ProfilePanel() {
  const [user, setUser] = useState<{ email: string; displayName: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const csrf = useRef("");
  const feedback = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    let active = true;
    void fetch("/api/v1/me", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error();
      const { data } = await response.json();
      if (active) { setUser(data.user); csrf.current = data.csrfToken; }
    }).catch(() => { if (active) setError("Sign in to view your profile, or try again later."); });
    return () => { active = false; };
  }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending.current) return;
    const displayName = new FormData(event.currentTarget).get("displayName");
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      // Refresh the session-bound challenge in case this browser rotated sessions.
      const challenge = await fetch("/api/v1/me", { cache: "no-store" });
      if (!challenge.ok) throw new Error();
      csrf.current = (await challenge.json()).data.csrfToken;
      const response = await fetch("/api/v1/me", { method: "PATCH", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.current }, body: JSON.stringify({ displayName }) });
      if (!response.ok) throw new Error();
      setUser((await response.json()).data.user); setNotice("Your profile has been saved.");
    } catch { setError("Your profile could not be saved. Check your session and try again."); }
    finally { pending.current = false; setBusy(false); requestAnimationFrame(() => feedback.current?.focus()); }
  }
  return <section className="auth-card" aria-labelledby="profile-heading">
    <h1 id="profile-heading">Your profile</h1>
    <p ref={feedback} tabIndex={-1} role={error ? "alert" : "status"}>{error || notice || (!user ? "Loading your profile…" : "")}</p>
    {user && <><p>{user.email}</p><form onSubmit={(event) => { void save(event); }} aria-busy={busy}>
      <fieldset disabled={busy} className="auth-fields"><label htmlFor="display-name">Display name</label>
        <input id="display-name" name="displayName" defaultValue={user.displayName} autoComplete="name" maxLength={100} />
        <Button type="submit">{busy ? "Saving…" : "Save profile"}</Button>
      </fieldset></form></>}
    <Link href="/login" className="text-link">Back to your account</Link>
  </section>;
}
