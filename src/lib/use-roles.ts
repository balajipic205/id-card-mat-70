import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { useAuth } from "./use-auth";

export type AppRole = "admin" | "volunteer" | "user";

/** Returns the set of roles for the current user. Re-fetches when session changes. */
export function useRoles() {
  const { user, loading: authLoading } = useAuth();
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (authLoading) return;
      if (!user) {
        if (!cancelled) {
          setRoles([]);
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id);
      if (cancelled) return;
      if (error) {
        setRoles([]);
      } else {
        setRoles((data ?? []).map((r: { role: AppRole }) => r.role));
      }
      setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [user, authLoading]);

  const isAdmin = roles.includes("admin");
  const isVolunteer = roles.includes("volunteer");
  return {
    roles,
    isAdmin,
    isVolunteer,
    isStaff: isAdmin || isVolunteer,
    loading: loading || authLoading,
  };
}
