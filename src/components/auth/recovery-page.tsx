import Link from "next/link";
import { RecoveryPanel, type RecoveryMode } from "./recovery-panel";
import { syntheticRecoveryUiEnabled } from "@/server/synthetic-recovery-ui";

export function RecoveryPage({ mode }: Readonly<{ mode: RecoveryMode }>) {
  return <><a className="skip-link" href="#main-content">Skip to content</a>
    <header className="auth-header"><Link href="/" className="text-link">LibraryOS</Link></header>
    <main id="main-content" tabIndex={-1} className="auth-main"><RecoveryPanel mode={mode} enabled={syntheticRecoveryUiEnabled()} /></main>
  </>;
}
