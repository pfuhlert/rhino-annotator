"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { safeNext } from "@/lib/share-link";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(mode: "login" | "register", e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "login") await api.login(username, password);
      else await api.register(username, password);
      router.push(safeNext(window.location.search) ?? "/annotate");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-sm py-0">
        <form className="space-y-5 p-6" onSubmit={(e) => submit("login", e)}>
          <div>
            <h1 className="font-heading text-xl font-medium">Simple annotator</h1>
            <p className="mt-1 text-sm text-muted-foreground">Sign in to label the next image.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="username" className="text-muted-foreground">
              Username
            </Label>
            <Input
              id="username"
              data-testid="username"
              aria-label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password" className="text-muted-foreground">
              Password
            </Label>
            <Input
              id="password"
              data-testid="password"
              aria-label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {error ? (
            <p data-testid="auth-error" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex gap-3">
            <Button data-testid="login-submit" className="flex-1" disabled={busy}>
              Log in
            </Button>
            <Button
              data-testid="register-submit"
              type="button"
              variant="outline"
              className="flex-1"
              disabled={busy}
              onClick={(e) => submit("register", e)}
            >
              Register
            </Button>
          </div>
        </form>
      </Card>
    </main>
  );
}
