"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./ui";

const links = [
  { href: "/", label: "Ride", icon: "M5 17h14M6 17l1.5-5h9L18 17M8 17v2m8-2v2M7.5 12 9 8h6l1.5 4" },
  { href: "/driver", label: "Drive", icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm-9 3h6m6 0h6m-9 3v6" },
  { href: "/fleet", label: "Fleet", icon: "M4 6h16M4 12h16M4 18h10" },
] as const;

export function Nav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className="flex shrink-0 items-center gap-1 bg-asphalt px-3 py-2 text-white md:w-20 md:flex-col md:px-2 md:py-4"
    >
      <Link href="/" className="mr-3 flex items-center gap-2 md:mr-0 md:mb-6" aria-label="RideShare home">
        <span className="grid size-9 place-items-center rounded-xl bg-route text-lg font-black">R</span>
        <span className="hidden font-bold sm:inline md:hidden">RideShare</span>
      </Link>
      <ul className="ml-auto flex gap-1 md:ml-0 md:flex-col md:gap-2">
        {links.map((link) => {
          const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex items-center gap-2 rounded-xl px-2.5 py-2 text-sm font-medium transition-colors md:w-16 md:flex-col md:gap-1 md:px-0 md:text-xs",
                  active ? "bg-asphalt-soft text-white" : "text-white/60 hover:text-white",
                )}
              >
                <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d={link.icon} />
                </svg>
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Map fills the screen; the panel floats over it on desktop and stacks below it on mobile. */
export function MapLayout({ panel, map }: { panel: React.ReactNode; map: React.ReactNode }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col md:block">
      <div className="isolate h-[45vh] shrink-0 md:absolute md:inset-0 md:h-auto">{map}</div>
      <div className="relative z-[1000] -mt-4 flex min-h-0 flex-1 flex-col md:absolute md:top-4 md:bottom-4 md:left-4 md:mt-0 md:w-[400px]">
        {panel}
      </div>
    </div>
  );
}
