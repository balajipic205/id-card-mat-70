import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/use-auth";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !session) {
      navigate({ to: "/login" });
    }
  }, [loading, session, navigate]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Checking session…
      </div>
    );
  }
  if (!session) return null;
  return <>{children}</>;
}
