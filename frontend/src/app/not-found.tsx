import Link from "next/link";

export default function NotFound() {
  return (
    <div className="grid flex-1 place-items-center p-8 text-center">
      <div>
        <h1 className="text-2xl font-bold">This page doesn’t exist</h1>
        <p className="mt-2 text-muted">Go back to booking a ride.</p>
        <Link href="/" className="mt-4 inline-block font-semibold text-route hover:underline">
          Open the Ride screen
        </Link>
      </div>
    </div>
  );
}
