"use client";

import { CheckCircle2, Loader2, Send } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { chatSend, type ChatChunk } from "@/lib/chat/client";
import type { IngestedFile } from "@/lib/files/types";
import type { QuestionId } from "@/lib/interview/library";
import { checkReadiness, type ReadinessResult } from "@/lib/interview/readiness";
import { rebuildSpec, type RebuildAnswer } from "@/lib/interview/rebuild-spec";
import type { Project } from "@/lib/project";
import { sidecarCall } from "@/lib/sidecar/client";

import { FilePanel } from "./components/file-panel";

interface DisplayMessage {
  role: "user" | "assistant";
  text: string;
}

interface AnswerRow {
  id: string;
  projectId: string;
  questionId: string;
  answerText: string;
  confidence: "confident" | "tentative" | "default-applied";
  source: "chat" | "file" | "default";
  rationale: string | null;
  createdAt: number;
}

type Status =
  | { kind: "idle" }
  | { kind: "streaming" }
  | { kind: "rate_limited"; message: string }
  | { kind: "error"; message: string };

const rowToRebuildAnswer = (row: AnswerRow): RebuildAnswer => ({
  questionId: row.questionId as QuestionId,
  answerText: row.answerText,
  confidence: row.confidence,
  source: row.source,
  rationale: row.rationale,
});

export default function InterviewPage() {
  return (
    <Suspense fallback={<InterviewSkeleton />}>
      <InterviewClient />
    </Suspense>
  );
}

function InterviewSkeleton() {
  return (
    <main className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
      Loading...
    </main>
  );
}

function InterviewClient() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get("project");

  const [project, setProject] = useState<Project | null>(null);
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);
  const [spec, setSpec] = useState<string>("");
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [readiness, setReadiness] = useState<ReadinessResult>(() => checkReadiness([]));
  const [echoBackConfirmed, setEchoBackConfirmed] = useState(false);
  const [files, setFiles] = useState<readonly IngestedFile[]>([]);
  const [pendingOptions, setPendingOptions] = useState<{
    question: string;
    options: readonly string[];
    allowFreeform: boolean;
  } | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load the project (or surface a clear error) whenever the URL param changes.
  useEffect(() => {
    if (!projectId) {
      setProjectLoadError("No project selected. Open one from the Welcome screen.");
      return;
    }
    let cancelled = false;
    void (async () => {
      const r = await sidecarCall<Project | null>("projects.get", { id: projectId });
      if (cancelled) return;
      r.match(
        (p) => {
          if (p === null) {
            setProjectLoadError(`Project ${projectId} not found.`);
          } else {
            setProject(p);
            setProjectLoadError(null);
          }
        },
        (e) => {
          setProjectLoadError(e.message);
        },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Pull answers from the sidecar and rebuild the spec preview + readiness.
  const refreshSpec = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    const r = await sidecarCall<AnswerRow[]>("answers.list", { projectId });
    r.match(
      (rows) => {
        const rebuildAnswers = rows.map(rowToRebuildAnswer);
        try {
          setSpec(rebuildSpec(rebuildAnswers));
        } catch (e) {
          setSpec(`# Spec preview error\n\n${e instanceof Error ? e.message : String(e)}`);
        }
        setReadiness(checkReadiness(rebuildAnswers, { echoBackConfirmed }));
      },
      () => {
        // Quietly ignore; transient sidecar issues will retry on next chat turn.
      },
    );
  }, [projectId, echoBackConfirmed]);

  // Initial spec render once the project is loaded.
  useEffect(() => {
    if (project) void refreshSpec();
  }, [project, refreshSpec]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, status]);

  const handleChunk = (chunk: ChatChunk): void => {
    switch (chunk.kind) {
      case "session":
        sessionIdRef.current = chunk.id;
        return;
      case "assistant_delta":
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [...prev.slice(0, -1), { role: "assistant", text: last.text + chunk.text }];
          }
          return [...prev, { role: "assistant", text: chunk.text }];
        });
        return;
      case "options_offered":
        setPendingOptions({
          question: chunk.question,
          options: chunk.options,
          allowFreeform: chunk.allow_freeform,
        });
        return;
      case "done":
        setStatus({ kind: "idle" });
        void refreshSpec();
        return;
      case "rate_limit":
        setStatus({ kind: "rate_limited", message: chunk.message });
        return;
      case "error":
        setStatus({ kind: "error", message: chunk.message });
        return;
    }
  };

  const handleSend = async (textOverride?: string): Promise<void> => {
    const raw = textOverride ?? input;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    if (status.kind === "streaming") return;
    if (!project) return;

    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    setInput("");
    setPendingOptions(null);
    setStatus({ kind: "streaming" });

    const result = await chatSend({
      prompt: trimmed,
      sessionId: sessionIdRef.current,
      projectId: project.id,
      projectPath: project.path,
      onChunk: handleChunk,
    });

    result.match(
      () => {
        setStatus((prev) => (prev.kind === "streaming" ? { kind: "idle" } : prev));
      },
      (error) => {
        setStatus({ kind: "error", message: error.message });
      },
    );
  };

  const handleOptionPick = (option: string): void => {
    if (pendingOptions === null) return;
    if (pendingOptions.allowFreeform) {
      // Pre-fill the textarea so the novice can edit before sending.
      setInput(option);
      setPendingOptions(null);
    } else {
      // Strict-pick: send immediately on click.
      void handleSend(option);
    }
  };

  const isStreaming = status.kind === "streaming";
  const isBlocked = status.kind === "streaming" || status.kind === "rate_limited" || !project;

  if (projectLoadError !== null) {
    return (
      <main className="flex h-screen items-center justify-center bg-background p-8">
        <Alert variant="destructive" className="max-w-xl">
          <AlertTitle>Cannot open the interview</AlertTitle>
          <AlertDescription>{projectLoadError}</AlertDescription>
        </Alert>
      </main>
    );
  }

  return (
    <main className="grid h-screen grid-rows-[auto_1fr] bg-background">
      <header className="flex items-center justify-between gap-4 border-b px-6 py-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">
            Interview{project ? ` — ${project.name}` : ""}
          </h1>
          <p className="text-sm text-muted-foreground">
            Tell Claude what you want to build. As you answer, the spec on the right rebuilds in
            real time.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span
            className="text-sm text-muted-foreground"
            aria-label="Fast-path interview progress"
          >
            {readiness.fastPathAnswered} / {readiness.fastPathTotal} answered
          </span>
          <Button
            type="button"
            disabled={!readiness.ready}
            title={readiness.ready ? "Start the build" : readiness.reason}
            onClick={() => {
              if (readiness.ready) {
                // The build dashboard lands at Phase D; for now, mark the user's intent.
                window.alert(
                  "Start build is wired in Phase D. The interview is complete and the spec is ready.",
                );
              } else if (readiness.fastPathAnswered === readiness.fastPathTotal) {
                setEchoBackConfirmed(true);
              }
            }}
          >
            <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden="true" />
            {readiness.ready
              ? "Start build"
              : readiness.fastPathAnswered === readiness.fastPathTotal
                ? "Confirm echo-back"
                : "Start build"}
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px]">
        <section className="flex min-h-0 flex-col">
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
            <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
              {messages.length === 0 && status.kind === "idle" && (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  Start by describing what you want to build, then send.
                </div>
              )}

              {messages.map((msg, i) => (
                <MessageBubble key={i} message={msg} />
              ))}

              {isStreaming && messages[messages.length - 1]?.role === "user" && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
                  <Loader2
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  Claude is thinking...
                </div>
              )}

              {status.kind === "rate_limited" && (
                <Alert variant="destructive">
                  <AlertTitle>Rate-limited</AlertTitle>
                  <AlertDescription>{status.message}</AlertDescription>
                </Alert>
              )}

              {status.kind === "error" && (
                <Alert variant="destructive">
                  <AlertTitle>Something went wrong</AlertTitle>
                  <AlertDescription>{status.message}</AlertDescription>
                </Alert>
              )}
            </div>
          </div>

          {pendingOptions !== null && (
            <div className="border-t bg-muted/40 px-6 py-3">
              <div className="mx-auto w-full max-w-2xl">
                <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                  Pick one{pendingOptions.allowFreeform ? " (or type your own below)" : ""}
                </p>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Answer options">
                  {pendingOptions.options.map((opt) => (
                    <Button
                      key={opt}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        handleOptionPick(opt);
                      }}
                    >
                      {opt}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="border-t px-6 py-4">
            <div className="mx-auto flex w-full max-w-2xl gap-2">
              <label htmlFor="chat-input" className="sr-only">
                Message
              </label>
              <textarea
                id="chat-input"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder={
                  status.kind === "rate_limited"
                    ? "Rate-limited; please wait."
                    : !project
                      ? "Loading project..."
                      : "Type a message..."
                }
                disabled={isBlocked}
                rows={2}
                className="block flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
              />
              <Button
                type="button"
                disabled={isBlocked || input.trim().length === 0}
                onClick={() => {
                  void handleSend();
                }}
                aria-label="Send message"
              >
                <Send className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>

          <FilePanel
            files={files}
            onDrop={(added) => {
              setFiles((prev) => [...prev, ...added]);
            }}
          />
        </section>

        <aside className="hidden min-h-0 border-l lg:flex lg:flex-col">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Spec preview</h2>
            <p className="text-xs text-muted-foreground">
              Rebuilt after each answer. (Diff highlighting deferred per drift D-007.)
            </p>
          </div>
          <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words bg-muted/40 p-4 text-xs leading-relaxed">
            {spec || "_(no answers recorded yet)_"}
          </pre>
        </aside>
      </div>
    </main>
  );
}

function MessageBubble({ message }: { message: DisplayMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={"flex " + (isUser ? "justify-end" : "justify-start")}>
      <div
        className={
          "max-w-[85%] whitespace-pre-wrap rounded-lg px-4 py-2 text-sm " +
          (isUser ? "bg-primary text-primary-foreground" : "bg-muted text-foreground")
        }
      >
        {message.text}
      </div>
    </div>
  );
}
