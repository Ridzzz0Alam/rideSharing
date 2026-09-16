import type { Metadata } from "next";
import { DriverConsole } from "@/components/DriverConsole";

export const metadata: Metadata = { title: "Drive" };

export default function DriverPage() {
  return <DriverConsole />;
}
