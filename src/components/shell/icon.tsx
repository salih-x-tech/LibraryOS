const paths = {
  book: "M4 4h6a3 3 0 0 1 3 3v14a5 5 0 0 0-5-3H4V4Zm16 0h-4a3 3 0 0 0-3 3v14a5 5 0 0 1 5-3h2V4Z",
  overview: "M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z",
  layers: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm12 10v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  arrows: "M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4",
  chart: "M4 3v18h17M9 16v-4m5 4V8m5 8V5",
  settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "m6 6 12 12M6 18 18 6",
  arrow: "M4 12h16m-6-6 6 6-6 6",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg aria-hidden="true" className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
    </svg>
  );
}
