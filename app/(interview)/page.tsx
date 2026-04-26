"use client";

import { Loader2, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { chatSend, type ChatChunk } from "@/lib/chat/client";

interface DisplayMessage {
  role: "user" | "assistant";
  text: string;
}

type Status =
  | { kind: "idle" }
  | { kind: "streaming" }
  | { kind: "rate_limited"; message: string }
  | { kind: "error"; message: string };

export default function InterviewPage() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const sessionIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
      case "done":
        setStatus({ kind: "idle" });
        return;
      case "rate_limit":
        setStatus({ kind: "rate_limited", message: chunk.message });
        return;
      case "error":
        setStatus({ kind: "error", message: chunk.message });
        return;
    }
  };

  const handleSend = async (): Promise<void> => {
    const trimmed = input.trim();
    if (trimmed.length === 0) return;
    if (status.kind === "streaming") return;

    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    setInput("");
    setStatus({ kind: "streaming" });

    const result = await chatSend({
      prompt: trimmed,
      sessionId: sessionIdRef.current,
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

  const isStreaming = status.kind === "streaming";
  const isBlocked = status.kind === "streaming" || status.kind === "rate_limited";

  return (
    <main className="flex h-screen flex-col bg-background">
      <header className="border-b px-6 py-4">
        <h1 className="text-lg font-semibold">Interview</h1>
        <p className="text-sm text-muted-foreground">
          Tell Claude what you want to build. It will ask follow-up questions.
        </p>
      </header>

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
            <div
              className="flex items-center gap-2 text-sm text-muted-foreground"
              aria-live="polite"
            >
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
          (isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground")
        }
      >
        {message.text}
      </div>
    </div>
  );
}
