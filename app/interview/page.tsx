"use client";

import { CheckCircle2, Loader2, Send } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { chatSend, type ChatChunk, type QueuedQuestion } from "@/lib/chat/client";
import { ingestFile } from "@/lib/files/ingest";
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
  // Echo-back gate retired in UX4 ("Build now" bypasses readiness); kept as
  // a const so any downstream readiness check still gets a defined value.
  const echoBackConfirmed = false;
  const [files, setFiles] = useState<readonly IngestedFile[]>([]);
  // UX3 batched-question pipeline: claude pre-fetches up to 10 questions per
  // turn via queue_questions; we render the head one at a time. Each answer
  // (click or freeform) goes into bufferedAnswers; when the queue empties we
  // flush the buffer in a single chat_send so claude can record_answer all
  // of them and queue the next batch — 1 round-trip per N answers.
  const [questionQueue, setQuestionQueue] = useState<readonly QueuedQuestion[]>([]);
  const [bufferedAnswers, setBufferedAnswers] = useState<
    readonly { id: string; text: string; question: string }[]
  >([]);
  const [isPreparingBank, setIsPreparingBank] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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

  // UX2: rehydrate the chat scrollback from chatMessages.list whenever the
  // project becomes available. Without this, a reload mid-interview shows
  // an empty conversation even though the answers are persisted in the DB.
  useEffect(() => {
    if (!project) return;
    void (async () => {
      const r = await sidecarCall<Array<{ role: "user" | "assistant"; text: string }>>(
        "chatMessages.list",
        { projectId: project.id },
      );
      r.match(
        (rows) => {
          if (rows.length > 0) {
            setMessages(rows.map((r) => ({ role: r.role, text: r.text })));
          }
        },
        () => {
          /* non-fatal — fresh empty chat is the right fallback */
        },
      );
    })();
  }, [project]);


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
      case "questions_queued":
        // Append to the queue so partial deliveries (rare) accumulate.
        setQuestionQueue((prev) => [...prev, ...chunk.items]);
        setIsPreparingBank(false);
        return;
      case "done":
        setStatus({ kind: "idle" });
        setIsPreparingBank(false);
        void refreshSpec();
        // UX2: persist the just-finished assistant turn so it survives a reload.
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (project && last?.role === "assistant" && last.text.trim().length > 0) {
            void sidecarCall("chatMessages.append", {
              projectId: project.id,
              role: "assistant",
              text: last.text,
            });
          }
          return prev;
        });
        return;
      case "rate_limit":
        setStatus({ kind: "rate_limited", message: chunk.message });
        return;
      case "error":
        setStatus({ kind: "error", message: chunk.message });
        return;
    }
  };

  // Low-level: send `text` to claude. Used for the initial pitch and for
  // flushing buffered answers when the queue empties.
  const sendToClaude = async (text: string): Promise<void> => {
    if (!project) return;
    const isFirstTurn = sessionIdRef.current === null;
    setStatus({ kind: "streaming" });
    if (isFirstTurn) setIsPreparingBank(true);

    const result = await chatSend({
      prompt: text,
      sessionId: sessionIdRef.current,
      projectId: project.id,
      projectPath: project.path,
      onChunk: handleChunk,
    });

    result.match(
      () => {
        setStatus((prev) => (prev.kind === "streaming" ? { kind: "idle" } : prev));
        setIsPreparingBank(false);
      },
      (error) => {
        setStatus({ kind: "error", message: error.message });
        setIsPreparingBank(false);
      },
    );
  };

  // Re-entrancy guard for flushBuffer. Without this, a fast double-click on
  // the manual "Send my N answers now" link can read the same closure-bound
  // buffer twice (React's setBufferedAnswers([]) is async) and double-send
  // record_answer calls. Ref instead of state so it's synchronous.
  const flushingRef = useRef(false);

  // Compile buffered answers as a single message claude can parse with one
  // record_answer call per entry. Format: "1) Q1: <answer> (q: <text>)".
  const flushBuffer = async (buffer: readonly { id: string; text: string; question: string }[]): Promise<void> => {
    if (buffer.length === 0) return;
    if (flushingRef.current) return;
    flushingRef.current = true;
    const compiled = buffer
      .map((b, i) => `${i + 1}) ${b.id}: ${b.text} — (you asked: "${b.question}")`)
      .join("\n");
    setBufferedAnswers([]);
    try {
      await sendToClaude(compiled);
    } finally {
      flushingRef.current = false;
    }
  };

  // Pop the head, buffer the answer, echo to chat. If queue empties, flush
  // the buffer in a single chat_send turn (so 1 round trip per N answers).
  const submitAnswerForHead = (answerText: string): void => {
    const head = questionQueue[0];
    if (!head || !project) return;
    const trimmed = answerText.trim();
    if (trimmed.length === 0) return;

    const entry = { id: head.id, text: trimmed, question: head.text };
    const newBuffer = [...bufferedAnswers, entry];
    const newQueue = questionQueue.slice(1);

    // Echo the answer into the chat scrollback + persist for reload.
    setMessages((prev) => [...prev, { role: "user", text: `${head.id}: ${trimmed}` }]);
    void sidecarCall("chatMessages.append", {
      projectId: project.id,
      role: "user",
      text: `${head.id}: ${trimmed}`,
    });

    setBufferedAnswers(newBuffer);
    setQuestionQueue(newQueue);
    setInput("");

    if (newQueue.length === 0) {
      void flushBuffer(newBuffer);
    }
  };

  // The input-box submit handler. If a queued question is on screen, the
  // input is the freeform answer for it; otherwise (first turn / between
  // batches) it goes straight to claude.
  const handleSendInput = (): void => {
    const trimmed = input.trim();
    if (trimmed.length === 0) return;
    if (status.kind === "streaming") return;
    if (!project) return;

    if (questionQueue[0]) {
      submitAnswerForHead(trimmed);
      return;
    }

    // No queued question — treat as a freeform turn (initial pitch or a
    // user-driven prompt between batches).
    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    void sidecarCall("chatMessages.append", {
      projectId: project.id,
      role: "user",
      text: trimmed,
    });
    setInput("");
    void sendToClaude(trimmed);
  };

  const handleOptionPick = (option: string): void => {
    // Click = answer head + advance queue.
    submitAnswerForHead(option);
  };

  const handleEnterMyOwn = (): void => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  };

  // Manual flush: useful if the novice wants to send their answers-so-far
  // before completing the queue.
  const handleManualFlush = (): void => {
    if (bufferedAnswers.length === 0) return;
    void flushBuffer(bufferedAnswers);
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
            disabled={!project}
            title={
              readiness.ready
                ? "Open the build dashboard"
                : `${readiness.fastPathAnswered} / ${readiness.fastPathTotal} answered — Claude will fill in defaults for the rest. You can keep answering questions later.`
            }
            onClick={() => {
              if (!project) return;
              if (!readiness.ready) {
                const ok = window.confirm(
                  `You've answered ${readiness.fastPathAnswered} of ${readiness.fastPathTotal} fast-path questions. Claude will fill in defaults for the rest from your interview so far. Continue to the build dashboard?`,
                );
                if (!ok) return;
              }
              window.location.href = `/build?project=${project.id}`;
            }}
          >
            <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden="true" />
            {readiness.ready ? "Start build" : "Build now"}
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

          {isPreparingBank && messages[messages.length - 1]?.role === "user" && (
            <div className="border-t bg-muted/40 px-6 py-3">
              <div
                className="mx-auto flex w-full max-w-2xl items-center gap-3 text-sm text-muted-foreground"
                aria-live="polite"
              >
                <Loader2
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                <div>
                  <strong className="text-foreground">Preparing question bank...</strong>{" "}
                  28 fast-path questions will guide your spec.
                </div>
              </div>
            </div>
          )}

          {questionQueue[0] && (
            <div className="border-t bg-muted/40 px-6 py-3">
              <div className="mx-auto w-full max-w-2xl">
                <div className="mb-2 flex items-baseline justify-between">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {questionQueue[0].id} · question {bufferedAnswers.length + 1} of {bufferedAnswers.length + questionQueue.length} in this batch
                  </p>
                  {bufferedAnswers.length > 0 ? (
                    <button
                      type="button"
                      onClick={handleManualFlush}
                      className="text-xs text-muted-foreground underline hover:text-foreground"
                      title="Send the answers you've given so far without finishing the batch"
                    >
                      Send my {bufferedAnswers.length} answer{bufferedAnswers.length === 1 ? "" : "s"} now
                    </button>
                  ) : null}
                </div>
                <p className="mb-3 text-sm font-medium">{questionQueue[0].text}</p>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Answer options">
                  {questionQueue[0].options.map((opt) => (
                    <Button
                      key={opt}
                      type="button"
                      variant="outline"
                      size="sm"
                      title="Click to answer this question"
                      onClick={() => {
                        handleOptionPick(opt);
                      }}
                    >
                      {opt}
                    </Button>
                  ))}
                  {questionQueue[0].options.length > 0 ? (
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      onClick={handleEnterMyOwn}
                      title="Type a freeform answer instead"
                    >
                      Enter my own response
                    </Button>
                  ) : null}
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
                ref={inputRef}
                id="chat-input"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendInput();
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
                  void handleSendInput();
                }}
                aria-label="Send message"
              >
                <Send className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>

          <FilePanel
            files={files}
            onDrop={(added, rawFiles) => {
              setFiles((prev) => [...prev, ...added]);
              if (!project) return;
              // Kick off ingest per file in parallel; update each row's
              // status as the orchestrator progresses.
              for (let i = 0; i < added.length; i++) {
                const ingested = added[i];
                const raw = rawFiles[i];
                if (ingested === undefined || raw === undefined) continue;
                const fileId = ingested.id;
                setFiles((prev) =>
                  prev.map((f) =>
                    f.id === fileId
                      ? { ...f, status: "processing" as const, statusMessage: "Reading..." }
                      : f,
                  ),
                );
                void (async () => {
                  const r = await ingestFile(raw, project.path);
                  r.match(
                    (result) => {
                      setFiles((prev) =>
                        prev.map((f) => {
                          if (f.id !== fileId) return f;
                          // Strip statusMessage (exactOptionalPropertyTypes
                          // forbids setting an optional field to undefined).
                          const rest: IngestedFile = { ...f };
                          delete (rest as { statusMessage?: string }).statusMessage;
                          return {
                            ...rest,
                            status: "done" as const,
                            summary: result.summary,
                            hasPiiWarning: result.hasPiiWarning,
                          };
                        }),
                      );
                    },
                    (error) => {
                      setFiles((prev) =>
                        prev.map((f) =>
                          f.id === fileId
                            ? { ...f, status: "error" as const, statusMessage: error.message }
                            : f,
                        ),
                      );
                    },
                  );
                })();
              }
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
          <div className="border-t bg-background p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Ready to build? Open the dashboard for live tail + controls.
              </p>
              {project ? (
                <Link
                  href={`/build?project=${project.id}`}
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                >
                  Open Build dashboard
                </Link>
              ) : (
                <Button size="sm" variant="outline" disabled>
                  Open Build dashboard
                </Button>
              )}
            </div>
          </div>
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
