"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { formatTime, statusLabel } from "@/lib/format";
import { useLiveState } from "@/lib/providers";
import type { Ride, RideStatus } from "@/lib/types";

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "danger" | "ghost";

const variants: Record<Variant, string> = {
  primary: "bg-route text-white hover:bg-route-ink disabled:bg-route/40",
  secondary: "bg-paper text-asphalt border border-line hover:border-asphalt disabled:text-muted",
  danger: "bg-paper text-drop border border-drop/40 hover:bg-drop hover:text-white disabled:opacity-50",
  ghost: "text-muted hover:text-asphalt underline-offset-4 hover:underline",
};

export function Button({
  variant = "primary",
  busy = false,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed",
        variants[variant],
        className,
      )}
    >
      {busy && <span className="size-3 animate-spin rounded-full border-2 border-current border-r-transparent" />}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 block text-sm font-medium">{label}</span>
      <input
        {...props}
        className="h-10 w-full rounded-lg border border-line bg-paper px-3 text-sm placeholder:text-muted/70 focus:border-route focus:outline-none"
      />
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Notice({ tone = "error", children }: { tone?: "error" | "info"; children: ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cx(
        "rounded-lg px-3 py-2 text-sm",
        tone === "error" ? "bg-drop/10 text-drop" : "bg-route/10 text-route-ink",
      )}
    >
      {children}
    </p>
  );
}

/** Floating panel docked over the map. */
export function Panel({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex max-h-full flex-col overflow-hidden rounded-2xl bg-paper shadow-[0_8px_30px_rgb(28_34_48/0.18)]">
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h1 className="text-xl font-bold tracking-tight">{title}</h1>
        {aside}
      </header>
      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">{children}</div>
    </section>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-semibold text-muted">{children}</h2>;
}

const liveCopy = {
  live: { text: "Live", dot: "bg-pickup" },
  connecting: { text: "Connecting", dot: "bg-signal" },
  reconnecting: { text: "Reconnecting", dot: "bg-signal" },
  offline: { text: "Polling", dot: "bg-muted" },
} as const;

export function LiveBadge() {
  const state = useLiveState();
  const { text, dot } = liveCopy[state];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-kerb px-2.5 py-1 text-xs font-medium text-muted"
      title={state === "offline" ? "Real-time updates are unavailable; refreshing every few seconds" : "Real-time updates connected"}
    >
      <span className={cx("size-2 rounded-full", dot)} />
      {text}
    </span>
  );
}

export function StatusPill({ status }: { status: RideStatus }) {
  const tone =
    status === "COMPLETED"
      ? "bg-pickup/12 text-pickup"
      : status === "CANCELLED"
        ? "bg-drop/10 text-drop"
        : status === "MATCHING" || status === "REQUESTED"
          ? "bg-signal/15 text-[#8a6200]"
          : "bg-route/10 text-route-ink";
  return <span className={cx("rounded-full px-2 py-0.5 text-xs font-semibold", tone)}>{statusLabel[status]}</span>;
}

// ───────────────────────── Status line ─────────────────────────

const STOPS: { status: RideStatus; label: string; detail: (ride: Ride) => string | null }[] = [
  { status: "MATCHING", label: "Finding a driver", detail: () => "Searching within 5 km of your pickup" },
  { status: "ACCEPTED", label: "Driver assigned", detail: (r) => (r.driverId ? `${r.driverId} accepted` : null) },
  { status: "DRIVER_ARRIVING", label: "Driver arriving", detail: (r) => r.pickupAddress },
  { status: "RIDE_STARTED", label: "On the way", detail: (r) => (r.startedAt ? `Picked up at ${formatTime(r.startedAt)}` : null) },
  { status: "COMPLETED", label: "Arrived", detail: (r) => (r.completedAt ? `${r.dropAddress}, ${formatTime(r.completedAt)}` : r.dropAddress) },
];

const ORDER: RideStatus[] = ["REQUESTED", "MATCHING", "ACCEPTED", "DRIVER_ARRIVING", "RIDE_STARTED", "COMPLETED"];

/**
 * The ride state machine drawn as a transit line. Stops already passed are solid,
 * the current stop pulses, and a cancelled ride cuts the line where it stopped.
 */
export function StatusLine({ ride }: { ride: Ride }) {
  const cancelled = ride.status === "CANCELLED";
  // For a cancelled ride, infer how far it got from what was recorded.
  const reached: RideStatus = cancelled
    ? ride.startedAt
      ? "RIDE_STARTED"
      : ride.driverId
        ? "ACCEPTED"
        : "MATCHING"
    : ride.status;
  const reachedIndex = ORDER.indexOf(reached);

  return (
    <ol className="relative" aria-label="Ride progress">
      {STOPS.map((stop, i) => {
        const index = ORDER.indexOf(stop.status);
        const done = index < reachedIndex || (ride.status === "COMPLETED" && index === reachedIndex);
        const current = !cancelled && index === reachedIndex && ride.status !== "COMPLETED";
        const cutHere = cancelled && index === reachedIndex;
        const skipped = stop.status === "DRIVER_ARRIVING" && done && !ride.startedAt && reachedIndex > index;
        const last = i === STOPS.length - 1;
        const future = !done && !current && !cutHere;

        return (
          <li key={stop.status} className="relative flex gap-4 pb-5 last:pb-0" aria-current={current ? "step" : undefined}>
            {!last && (
              <span
                aria-hidden
                className={cx(
                  "absolute top-5 left-[9px] h-[calc(100%-12px)] w-1 rounded-full",
                  done ? "bg-route" : cancelled && index >= reachedIndex ? "bg-transparent" : "bg-line",
                )}
              />
            )}
            <span
              aria-hidden
              className={cx(
                "relative z-10 mt-0.5 size-[22px] shrink-0 rounded-full border-4",
                done && "border-route bg-route",
                current && "stop-current border-signal bg-paper",
                cutHere && "border-drop bg-paper",
                future && "border-line bg-paper",
              )}
            />
            <div className={cx("min-w-0", future && "text-muted")}>
              <p className={cx("font-semibold leading-6", cutHere && "text-drop")}>
                {stop.label}
              </p>
              {cutHere && ride.cancellationReason ? (
                <p className="text-sm text-drop">Cancelled: {ride.cancellationReason}</p>
              ) : (
                (done || current) &&
                !skipped && <p className="truncate text-sm text-muted">{stop.detail(ride)}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export { cx };
