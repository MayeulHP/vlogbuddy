import { eq } from "drizzle-orm";
import { db } from "./client";
import { appSettings } from "./schema";
import { DEFAULT_RENDER_SETTINGS, type RenderSettings } from "@vlogbuddy/shared";

/**
 * Instance settings, read the same way by the web app and the worker.
 *
 * Lives in `packages/db` rather than either app because the render job needs it
 * as much as the admin page does, and neither should own it.
 */

/** Env only seeds the very first boot; after that the row is the truth. */
function seedFromEnv(): RenderSettings {
  const number = (value: string | undefined, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
  };
  return {
    renderHeight: number(process.env.RENDER_HEIGHT, DEFAULT_RENDER_SETTINGS.renderHeight),
    renderFps: number(process.env.RENDER_FPS, DEFAULT_RENDER_SETTINGS.renderFps),
    renderCrf: DEFAULT_RENDER_SETTINGS.renderCrf,
    renderPreset: DEFAULT_RENDER_SETTINGS.renderPreset,
  };
}

export async function getRenderSettings(): Promise<RenderSettings> {
  /**
   * Tolerates the table not being there yet. The worker and the web app boot
   * independently and only the web app runs migrations, so for a few seconds
   * after a deploy this query can hit a database that hasn't caught up — which
   * is no reason to take the worker down.
   */
  let row: typeof appSettings.$inferSelect | undefined;
  try {
    [row] = await db.select().from(appSettings).where(eq(appSettings.id, true)).limit(1);
  } catch {
    return seedFromEnv();
  }
  if (!row) return seedFromEnv();
  return {
    renderHeight: row.renderHeight,
    renderFps: row.renderFps,
    renderCrf: row.renderCrf,
    renderPreset: row.renderPreset as RenderSettings["renderPreset"],
  };
}

export async function saveRenderSettings(settings: RenderSettings): Promise<RenderSettings> {
  const [row] = await db
    .insert(appSettings)
    .values({ id: true, ...settings, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: { ...settings, updatedAt: new Date() },
    })
    .returning();

  return {
    renderHeight: row.renderHeight,
    renderFps: row.renderFps,
    renderCrf: row.renderCrf,
    renderPreset: row.renderPreset as RenderSettings["renderPreset"],
  };
}
