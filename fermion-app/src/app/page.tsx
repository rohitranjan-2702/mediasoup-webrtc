import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center h-screen gap-4">
      <Link
        href="/stream"
        className="text-2xl font-bold text-blue-400 cursor-pointer hover:text-blue-600"
      >
        Join Stream
      </Link>
      <Link
        href="/watch"
        className="text-2xl font-bold text-red-400 cursor-pointer hover:text-red-600"
      >
        Watch Stream
      </Link>
    </div>
  );
}
