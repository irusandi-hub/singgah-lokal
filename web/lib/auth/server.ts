import { type ProducerAccess, type ProducerRole } from "@/lib/producer";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type AuthenticatedActor = {
  userId: string;
  producerId?: string;
  producerRole?: ProducerRole;
};

export type ServerAuthProvider = {
  authenticate(request: Request): Promise<AuthenticatedActor | null>;
};

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("Authenticated user is required");
  }
}

export class ProducerAuthorizationRequiredError extends Error {
  constructor() {
    super("Producer authorization is required for this Place");
  }
}

class SupabaseAuthProvider implements ServerAuthProvider {
  async authenticate(): Promise<AuthenticatedActor | null> {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: userError } = await supabase.auth.getUser();

    if (userError || !userData.user) {
      return null;
    }

    const { data: membership } = await supabase
      .from("producer_memberships")
      .select("producer_id, role")
      .eq("user_id", userData.user.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    return {
      userId: userData.user.id,
      producerId: membership?.producer_id,
      producerRole: membership?.role as ProducerRole | undefined,
    };
  }
}

let authProvider: ServerAuthProvider = new SupabaseAuthProvider();

export function setServerAuthProvider(provider: ServerAuthProvider): void {
  authProvider = provider;
}

export async function requireAuthenticatedActor(request: Request): Promise<AuthenticatedActor> {
  const actor = await authProvider.authenticate(request);

  if (!actor?.userId.trim()) {
    throw new AuthenticationRequiredError();
  }

  return actor;
}

export async function requireProducerAccess(request: Request, placeId: string, roles: ProducerRole[] = ["owner", "manager"]): Promise<ProducerAccess> {
  const actor = await requireAuthenticatedActor(request);
  const supabase = await createSupabaseServerClient();
  const { data: membership } = await supabase
    .from("producer_memberships")
    .select("producer_id, role, place_id")
    .eq("user_id", actor.userId)
    .eq("place_id", placeId)
    .in("role", roles)
    .maybeSingle();

  if (!membership) {
    throw new ProducerAuthorizationRequiredError();
  }

  return {
    producerId: String(membership.producer_id),
    role: membership.role as ProducerRole,
    placeId: String(membership.place_id),
  };
}

export async function requireProducerOwner(request: Request): Promise<AuthenticatedActor> {
  const actor = await requireAuthenticatedActor(request);
  if (actor.producerRole !== "owner" || !actor.producerId) throw new ProducerAuthorizationRequiredError();
  return actor;
}