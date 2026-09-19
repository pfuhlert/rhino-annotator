"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

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
      router.push("/annotate");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <form
        className="w-full max-w-sm space-y-5 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-8"
        onSubmit={(e) => submit("login", e)}
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Simple annotator</h1>
          <p className="mt-1 text-sm text-zinc-400">Sign in to label the next crop.</p>
        </div>
        <label className="block text-sm">
          <span className="text-zinc-400">Username</span>
          <input
            data-testid="username"
            aria-label="Username"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 outline-none focus:border-zinc-400"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label className="block text-sm">
          <span className="text-zinc-400">Password</span>
          <input
            data-testid="password"
            aria-label="Password"
            type="password"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 outline-none focus:border-zinc-400"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error ? (
          <p data-testid="auth-error" className="text-sm text-rose-400">
            {error}
          </p>
        ) : null}
        <div className="flex gap-3">
          <button
            data-testid="login-submit"
            disabled={busy}
            className="flex-1 rounded-lg bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-950 disabled:opacity-50"
          >
            Log in
          </button>
          <button
            data-testid="register-submit"
            type="button"
            disabled={busy}
            onClick={(e) => submit("register", e)}
            className="flex-1 rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            Register
          </button>
        </div>
      </form>
    </main>
  );
}
