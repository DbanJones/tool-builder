// One-page marketing site per build-order.md E6.
//
// Download links + the 90s screen recording are placeholders until:
//   - Phase E0 ships signed installers (Apple Developer ID + Windows
//     code-signing cert + Tauri keypair are provisioned).
//   - A real demo recording is captured.
// Both are deferred per drift D-020.

const DOWNLOAD_LINKS_PENDING = true; // flip to false once E0 + E0.x land
const SCREEN_RECORDING_URL: string | null = null; // set to /demo.mp4 once recorded

export default function MarketingPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-12 px-6 py-16">
      <header className="text-center">
        <p className="text-xs uppercase tracking-widest text-zinc-500">Builder</p>
        <h1 className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">
          Chat your way to a deployed web app.
        </h1>
        <p className="mt-4 text-lg text-zinc-600 dark:text-zinc-300">
          A desktop app that turns a 90-minute conversation with Claude into a working,
          deployed Phase 1 product. Designed for absolute novices.
        </p>
      </header>

      <section className="rounded-lg border border-zinc-200 bg-zinc-50/40 p-8 text-center dark:border-zinc-800 dark:bg-zinc-900/40">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Watch a 90-second demo</h2>
        {SCREEN_RECORDING_URL ? (
          <video
            controls
            preload="metadata"
            className="mt-4 mx-auto w-full max-w-2xl rounded-md shadow-lg"
          >
            <source src={SCREEN_RECORDING_URL} type="video/mp4" />
            Your browser does not support the video tag.
          </video>
        ) : (
          <div className="mt-4 mx-auto flex aspect-video w-full max-w-2xl items-center justify-center rounded-md border border-dashed border-zinc-300 bg-white text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950">
            Demo recording coming soon.
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-4 text-center text-xs font-semibold uppercase tracking-widest text-zinc-500">
          Download
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <DownloadCard label="macOS" file="Builder.dmg" />
          <DownloadCard label="Windows" file="Builder.msi" />
          <DownloadCard label="Linux" file="Builder.AppImage" />
        </div>
        {DOWNLOAD_LINKS_PENDING ? (
          <p className="mt-4 text-center text-xs text-zinc-500">
            Signed installers ship after Phase E0 (code-signing certs + notarisation).
            See <a className="underline" href="https://github.com/" rel="noopener noreferrer">the repo</a>{" "}
            for build instructions in the meantime.
          </p>
        ) : null}
      </section>

      <section className="space-y-4">
        <h2 className="text-center text-xs font-semibold uppercase tracking-widest text-zinc-500">
          What you get
        </h2>
        <ul className="mx-auto grid max-w-2xl grid-cols-1 gap-4 sm:grid-cols-3 text-sm">
          <li className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
            <strong className="block font-semibold">Recursive interview</strong>
            <span className="text-zinc-600 dark:text-zinc-300">28 questions, smart follow-ups, one click per answer.</span>
          </li>
          <li className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
            <strong className="block font-semibold">Live build dashboard</strong>
            <span className="text-zinc-600 dark:text-zinc-300">Watch every file edit, every command, sub-second.</span>
          </li>
          <li className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
            <strong className="block font-semibold">One-click deploy</strong>
            <span className="text-zinc-600 dark:text-zinc-300">Vercel preview URL on tap; private GitHub repo on tap.</span>
          </li>
        </ul>
      </section>

      <footer className="text-center text-xs text-zinc-500">
        Built with Tauri 2 + Next.js 15. Source on{" "}
        <a className="underline" href="https://github.com/" rel="noopener noreferrer">
          GitHub
        </a>
        .
      </footer>
    </main>
  );
}

function DownloadCard({ label, file }: { label: string; file: string }) {
  const href = DOWNLOAD_LINKS_PENDING ? "#downloads-pending" : `/downloads/${file}`;
  return (
    <a
      href={href}
      aria-disabled={DOWNLOAD_LINKS_PENDING}
      className={
        "block rounded-md border p-4 text-center transition " +
        (DOWNLOAD_LINKS_PENDING
          ? "cursor-not-allowed border-zinc-200 bg-zinc-50 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500"
          : "border-zinc-300 hover:border-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900")
      }
    >
      <div className="text-sm font-semibold">{label}</div>
      <div className="mt-1 text-xs">{file}</div>
    </a>
  );
}
