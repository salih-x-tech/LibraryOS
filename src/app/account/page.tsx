import Link from "next/link";
import { ProfilePanel } from "@/components/auth/profile-panel";
export const metadata = { title: "Your profile | LibraryOS" };
export default function AccountPage() {
  return <><a href="#main-content" className="skip-link">Skip to content</a>
    <header className="auth-header"><Link href="/" className="text-link">LibraryOS</Link></header>
    <main id="main-content" tabIndex={-1} className="auth-main"><ProfilePanel /></main></>;
}
