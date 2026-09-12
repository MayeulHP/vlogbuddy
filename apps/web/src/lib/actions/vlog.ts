"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, db, eq, members, selections, timelines, vlogs } from "@vlogbuddy/db";
import {
  DEFAULT_REACTIONS,
  createVlogSchema,
  emptyTimeline,
  generateSlug,
  generateToken,
  joinVlogSchema,
  setStateSchema,
  type VlogState,
} from "@vlogbuddy/shared";
import {
  getVlogBySlug,
  hashPasscode,
  requireCreator,
  requireMemberBySlug,
  setSessionCookie,
  verifyPasscode,
  getCurrentMember,
} from "../session";
import { emitToVlog } from "../realtime";

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function createVlogAction(formData: FormData) {
  const parsed = createVlogSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description") || undefined,
    creatorName: formData.get("creatorName"),
    passcode: formData.get("passcode") || undefined,
  });

  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0].message };
  }

  const { title, description, creatorName, passcode } = parsed.data;

  // Slugs are random; retry on the vanishingly rare collision.
  let slug = generateSlug();
  for (let i = 0; i < 5; i++) {
    const existing = await getVlogBySlug(slug);
    if (!existing) break;
    slug = generateSlug();
  }

  const sessionToken = generateToken();

  const vlogId = await db.transaction(async (tx) => {
    const [vlog] = await tx
      .insert(vlogs)
      .values({
        title,
        description: description ?? null,
        shareSlug: slug,
        passcodeHash: passcode ? hashPasscode(passcode) : null,
        reactionTiers: DEFAULT_REACTIONS,
        state: "open",
      })
      .returning();

    await tx.insert(members).values({
      vlogId: vlog.id,
      displayName: creatorName,
      sessionToken,
      role: "creator",
    });

    await tx.insert(timelines).values({
      vlogId: vlog.id,
      doc: emptyTimeline(),
      revision: 0,
    });

    return vlog.id;
  });

  await setSessionCookie(vlogId, sessionToken);
  redirect(`/v/${slug}`);
}

export async function joinVlogAction(slug: string, formData: FormData) {
  const parsed = joinVlogSchema.safeParse({
    displayName: formData.get("displayName"),
    passcode: formData.get("passcode") || undefined,
  });

  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0].message };
  }

  const vlog = await getVlogBySlug(slug);
  if (!vlog) return { ok: false as const, error: "This vlog doesn't exist" };

  if (vlog.passcodeHash) {
    const passcode = parsed.data.passcode ?? "";
    if (!passcode || !verifyPasscode(passcode, vlog.passcodeHash)) {
      return { ok: false as const, error: "Wrong passcode" };
    }
  }

  const sessionToken = generateToken();
  const [member] = await db
    .insert(members)
    .values({
      vlogId: vlog.id,
      displayName: parsed.data.displayName,
      sessionToken,
      role: "friend",
    })
    .returning();

  await setSessionCookie(vlog.id, sessionToken);

  emitToVlog(vlog.id, "member:joined", {
    memberId: member.id,
    displayName: member.displayName,
    color: "#8b5cf6",
  });

  redirect(`/v/${slug}`);
}

export async function setVlogStateAction(slug: string, state: VlogState): Promise<ActionResult> {
  const parsed = setStateSchema.safeParse({ state });
  if (!parsed.success) return { ok: false, error: "Unknown phase" };

  try {
    const session = await requireMemberBySlug(slug);
    requireCreator(session);

    /**
     * Rendering is the only thing that moves a film forward, and
     * `startRenderAction` owns that step (the worker owns `published`). So this
     * action is purely the way back: a printed film can be reopened and re-cut
     * without anyone being stuck.
     */
    if (parsed.data.state !== "open") {
      return { ok: false, error: "Start a render from the bench to move the film on" };
    }

    await db
      .update(vlogs)
      .set({ state: parsed.data.state, updatedAt: new Date() })
      .where(eq(vlogs.id, session.vlog.id));

    emitToVlog(session.vlog.id, "vlog:state", { state: parsed.data.state });
    revalidatePath(`/v/${slug}`, "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Something went wrong" };
  }
}

export async function renameMemberAction(slug: string, displayName: string): Promise<ActionResult> {
  const name = displayName.trim().slice(0, 40);
  if (!name) return { ok: false, error: "Pick a name" };
  try {
    const session = await requireMemberBySlug(slug);
    await db.update(members).set({ displayName: name }).where(eq(members.id, session.member.id));
    revalidatePath(`/v/${slug}`, "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Something went wrong" };
  }
}

export async function updateVlogAction(
  slug: string,
  data: { title?: string; description?: string },
): Promise<ActionResult> {
  try {
    const session = await requireMemberBySlug(slug);
    requireCreator(session);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (data.title !== undefined) {
      const title = data.title.trim();
      if (!title) return { ok: false, error: "Title can't be empty" };
      patch.title = title.slice(0, 120);
    }
    if (data.description !== undefined) {
      patch.description = data.description.trim().slice(0, 1000) || null;
    }

    await db.update(vlogs).set(patch).where(eq(vlogs.id, session.vlog.id));
    revalidatePath(`/v/${slug}`, "layout");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Something went wrong" };
  }
}
