import Link from "next/link";
import { AppScreen } from "@/components/dashboard/app-screen";

export default function DocsPage() {
  return (
    <AppScreen header={<h1 className="text-xl font-semibold">Docs</h1>}>
      <p className="text-sm text-zinc-600">
        See the{" "}
        <Link href="/docs/api" className="underline">
          API reference
        </Link>{" "}
        for how to point your OpenAI/Anthropic client at the TokenGuard proxy.
      </p>
    </AppScreen>
  );
}
