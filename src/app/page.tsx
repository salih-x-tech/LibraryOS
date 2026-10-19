import { AppShell } from "@/components/shell/app-shell";
import { Icon, type IconName } from "@/components/shell/icon";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const features: ReadonlyArray<{ name: string; icon: IconName; description: string; number: string }> = [
  { name: "A home for every book", icon: "book", description: "One considered catalog. Every copy, shelf and branch in its place.", number: "01" },
  { name: "Borrowing, made simpler", icon: "arrows", description: "Less time at the counter. More time connecting readers with their next chapter.", number: "02" },
  { name: "People at the heart", icon: "users", description: "A welcoming space for your members and the people who look after them.", number: "03" },
];

export default function HomePage() {
  return (
    <AppShell>
      <main id="main-content" tabIndex={-1} className="page-content">
        <div className="page-intro"><p className="eyebrow">A new chapter begins</p><h1>Your library,<br /><em>thoughtfully organized.</em></h1><p>A calmer home for your collection, your people and all the stories in between.</p></div>
        <section className="welcome-panel" aria-labelledby="welcome-heading">
          <div className="welcome-copy"><span className="eyebrow">Welcome to LibraryOS</span><h2 id="welcome-heading">Great stories deserve<br />a beautiful home.</h2><p>From the first shelf to your next branch, make space for a library that grows with your community.</p><a className="text-link" href="#getting-started">Explore your workspace<Icon name="arrow" /></a></div>
          <div className="book-illustration" aria-hidden="true"><span className="illustration-orbit" /><span className="illustration-star">✦</span><div className="book book-one"><span>STORIES</span><i /></div><div className="book book-two"><i /><span>THE READING<br />ROOM</span><i /></div><div className="book book-three"><span>A WORLD<br />WITHIN</span><i /></div><div className="book-shelf" /></div>
        </section>
        <section id="getting-started" tabIndex={-1} aria-labelledby="getting-started-heading" className="getting-started"><div className="section-heading"><div><p className="eyebrow">Made for your everyday</p><h2 id="getting-started-heading">A little order. Endless possibilities.</h2></div><span className="section-caption">Library tools · coming soon</span></div><div className="feature-grid">{features.map((feature) => <Card key={feature.name} className="feature-card"><CardHeader><div className="feature-top"><span className="feature-icon"><Icon name={feature.icon} /></span><span className="feature-number">{feature.number}</span></div><CardTitle>{feature.name}</CardTitle><CardDescription>{feature.description}</CardDescription><span className="feature-status">Coming soon</span></CardHeader></Card>)}</div></section>
        <section className="setup-note" aria-label="Workspace availability"><span className="setup-symbol" aria-hidden="true">✧</span><div><h2>Every good library starts somewhere.</h2><p>Your workspace is taking shape. Organization setup and library tools will be available in a future update.</p></div><span className="setup-tag">A considered beginning</span></section>
      </main>
    </AppShell>
  );
}
