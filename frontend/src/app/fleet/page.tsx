import type { Metadata } from "next";
import { FleetConsole } from "@/components/FleetConsole";

export const metadata: Metadata = { title: "Fleet" };

export default function FleetPage() {
  return <FleetConsole />;
}
