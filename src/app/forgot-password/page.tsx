import { RecoveryPage } from "@/components/auth/recovery-page";
export const dynamic = "force-dynamic";
export const metadata = { title: "Password help | LibraryOS", referrer: "no-referrer" as const };
export default function Page() { return <RecoveryPage mode="reset-request" />; }
