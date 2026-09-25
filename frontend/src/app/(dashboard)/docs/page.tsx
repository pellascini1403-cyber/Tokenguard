import Link from "next/link";

export default function DocsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-900">Docs</h1>
      <p className="text-sm text-zinc-600">
        See the{" "}
        <Link href="/docs/api" className="underline">
          API reference
        </Link>{" "}
        for how to point your OpenAI/Anthropic client at the TokenGuard proxy.
      </p>
    </div>
  );
}
