"use client";

import { useRef, useState, type ReactNode } from "react";
import { MotionConfig, motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "./icon";

const upcoming: ReadonlyArray<{ label: string; icon: IconName }> = [
  { label: "Catalog", icon: "book" },
  { label: "Circulation", icon: "arrows" },
  { label: "Members", icon: "users" },
  { label: "Reports", icon: "chart" },
];

export function AppShell({ children }: Readonly<{ children: ReactNode }>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const reducedMotion = useReducedMotion();

  return (
    <MotionConfig reducedMotion="user">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="app-shell">
        <aside className="sidebar" aria-label="Workspace sidebar" onKeyDown={(event) => {
          if (menuOpen && event.key === "Escape") {
            setMenuOpen(false);
            menuButton.current?.focus();
          }
        }}>
          <div className="sidebar-brand-row">
            <motion.a className="brand" href="#main-content" initial={false} whileHover={{ y: reducedMotion ? 0 : -1 }}>
              <span className="brand-mark"><Icon name="book" /></span>
              <span>Library<span className="brand-suffix">OS</span><small>A place for every chapter</small></span>
            </motion.a>
            <Button ref={menuButton} className="menu-toggle" variant="outline" aria-expanded={menuOpen} aria-controls="workspace-navigation" aria-label={menuOpen ? "Close navigation" : "Open navigation"} onClick={() => setMenuOpen(!menuOpen)}>
              <Icon name={menuOpen ? "close" : "menu"} />
            </Button>
          </div>
          <div className="sidebar-panel" data-open={menuOpen}>
            <p className="sidebar-label">Your workspace</p>
            <nav id="workspace-navigation" aria-label="Main navigation">
              <a className="nav-item nav-active" aria-current="page" href="#main-content" onClick={() => setMenuOpen(false)}><Icon name="overview" />Overview<span className="active-dot" /></a>
              <a className="nav-item" href="#getting-started" onClick={() => setMenuOpen(false)}><Icon name="layers" />Getting started</a>
              <p className="sidebar-label nav-group-label">Library tools</p>
              <ul className="upcoming-nav" aria-label="Upcoming library tools">
                {upcoming.map((item) => <li className="nav-item nav-upcoming" key={item.label}><Icon name={item.icon} /><span>{item.label}</span><span className="soon-label">Soon</span></li>)}
              </ul>
            </nav>
            <div className="sidebar-note"><span className="note-flourish" aria-hidden="true">✦</span><p>Good libraries begin<br />with a little care.</p><span>A thoughtful space, taking shape.</span></div>
            <div className="sidebar-footer"><Icon name="settings" /><span>Workspace setup coming soon</span></div>
          </div>
        </aside>
        <div className="workspace-body">
          <header className="topbar"><div className="breadcrumb"><span>Workspace</span><span aria-hidden="true">/</span><strong>Overview</strong></div><a className="text-link" href="/login">Sign in</a><span className="preview-label"><span aria-hidden="true" />Workspace preview</span></header>
          {children}
          <footer className="page-footer"><span>LibraryOS</span><p>More room for books. More time for people.</p><span className="footer-ornament" aria-hidden="true">✦</span></footer>
        </div>
      </div>
    </MotionConfig>
  );
}
