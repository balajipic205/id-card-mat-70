import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Toaster, toast } from "sonner";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign in — Make-A-Thon 7.0 Operations Console" },
      {
        name: "description",
        content:
          "Admin sign-in for Make-A-Thon 7.0: ID cards, payment exports, attendance scanning.",
      },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const { session, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && session) navigate({ to: "/" });
  }, [loading, session, navigate]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Signed in.");
    router.invalidate();
    navigate({ to: "/" });
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center px-6">
      <Toaster theme="dark" position="top-right" richColors />

      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-32 top-10 h-96 w-96 rounded-full bg-m7-pink/30 blur-3xl" />
        <div className="absolute -right-32 bottom-10 h-96 w-96 rounded-full bg-m7-cyan/30 blur-3xl" />
      </div>

      <div className="relative z-10 grid w-full max-w-5xl gap-10 lg:grid-cols-2 lg:items-center">
        <div className="hidden lg:block">
          <div className="text-xs uppercase tracking-[0.3em] text-m7-cyan">
            Make-A-Thon 7.0
          </div>
          <h1 className="mt-3 font-display text-5xl font-extrabold leading-tight">
            <span className="glitch">OPERATIONS</span>
            <br />
            <span className="text-gradient-spider">CONSOLE</span>
          </h1>
          <p className="mt-4 max-w-md text-sm text-muted-foreground">
            One place to print ID cards, export team data, pull payment proofs,
            and scan attendance — built for the volunteer crew running the show.
          </p>
          <div className="gradient-bar mt-6 w-32 animate-shimmer" />
        </div>

        <form
          onSubmit={onSubmit}
          className="w-full space-y-5 rounded-2xl border border-border bg-card/80 p-8 shadow-glow-pink backdrop-blur-xl"
        >
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-md bg-gradient-spider font-mono text-sm font-bold text-primary-foreground">
              M7
            </div>
            <div>
              <div className="font-display text-sm font-bold tracking-tight">
                Sign in
              </div>
              <div className="text-xs text-muted-foreground">
                Volunteers & admins only
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <Button
            type="submit"
            className="w-full bg-gradient-spider text-primary-foreground shadow-glow-pink"
            disabled={submitting}
          >
            {submitting ? "Signing in…" : "Enter the multiverse"}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Use your Cloud admin credentials.
          </p>
        </form>
      </div>
    </div>
  );
}
