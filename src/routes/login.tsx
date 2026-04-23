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
      { title: "Admin Login — Makeathon 7.0 ID Card Studio" },
      { name: "description", content: "Admin sign-in to access participant data and generate ID cards." },
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
    if (!loading && session) {
      navigate({ to: "/" });
    }
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
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <Toaster theme="dark" position="top-right" richColors />
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-5 rounded-xl border border-border bg-card p-8 shadow-2xl"
      >
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-md bg-primary font-mono text-sm font-bold text-primary-foreground">
            M7
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight">Makeathon 7.0</div>
            <div className="text-xs text-muted-foreground">Admin sign-in</div>
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
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          Use the admin credentials from your Supabase project.
        </p>
      </form>
    </div>
  );
}
