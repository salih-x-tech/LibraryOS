import { cookies } from "next/headers";
import Link from "next/link";
import { AuthPanel } from "@/components/auth/auth-panel";
import { SESSION_COOKIE_NAME } from "@/modules/auth/session-format";
import { getAuthService } from "@/server/auth-runtime";

export const runtime = "nodejs";
export const metadata = { title: "Sign in | LibraryOS" };

export default async function LoginPage() {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  let state: "signed-in" | "signed-out" | "unavailable" = "signed-out";
  if (token) {
    try { state = await (await getAuthService()).resolveSession(token) ? "signed-in" : "signed-out"; }
    catch { state = "unavailable"; }
  }
  return <>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="auth-header"><Link href="/" className="text-link">LibraryOS</Link><span>A place for every chapter</span></header>
    <main id="main-content" tabIndex={-1} className="auth-main">
      <AuthPanel initialState={state} hasSessionCookie={Boolean(token)} />
    </main>
  </>;
}
