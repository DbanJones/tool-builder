"use client";

import { ShieldCheck } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { verifyPassword } from "@/lib/demo";

interface AdminLoginProps {
  onSuccess: () => void;
}

export function AdminLogin({ onSuccess }: AdminLoginProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const ok = await verifyPassword(password);
      if (!ok) {
        setError("Incorrect password.");
        setPending(false);
        return;
      }
      onSuccess();
    } catch (e) {
      setError(`Couldn't verify: ${e instanceof Error ? e.message : String(e)}`);
      setPending(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="mb-2 flex items-center gap-3">
          <ShieldCheck className="h-6 w-6" aria-hidden="true" />
          <CardTitle>Admin sign-in</CardTitle>
        </div>
        <CardDescription>
          Authenticate to view demo lockout state and unlock controls.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void submit(e)} className="space-y-3">
          <label className="block text-sm">
            <span className="font-medium">Password</span>
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error !== null}
              aria-describedby={error ? "admin-login-error" : undefined}
              disabled={pending}
              className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-primary"
              placeholder="••••••••••"
            />
          </label>
          {error ? (
            <p id="admin-login-error" role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="sm" disabled={pending || password.length === 0}>
            {pending ? "Verifying…" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
