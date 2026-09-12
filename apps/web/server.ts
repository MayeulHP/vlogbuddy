/**
 * Custom Next.js server. We need our own HTTP server so Socket.IO can share the
 * port — that's what powers live voting, presence and collaborative editing.
 */
import { createServer } from "node:http";
import next from "next";
import { Server as SocketServer } from "socket.io";
import { parse } from "node:url";
import {
  applyTimelineOp,
  colorForMember,
  roomForVlog,
  timelineOpSchema,
  emptyTimeline,
  type ClientToServerEvents,
  type PresenceMember,
  type ServerToClientEvents,
} from "@vlogbuddy/shared";
import { and, db, eq, getSqlClient, members, timelines, vlogs } from "@vlogbuddy/db";
import crypto from "node:crypto";

const NOTIFY_CHANNEL = "vlogbuddy_events";

/**
 * The worker runs in its own process, so it publishes events on a Postgres
 * NOTIFY channel. We relay them into the right Socket.IO room here — that's how
 * "your video finished processing" and render progress reach the browser.
 */
async function bridgeWorkerEvents(io: SocketServer) {
  try {
    const sql = getSqlClient();
    await sql.listen(NOTIFY_CHANNEL, (payload: string) => {
      try {
        const event = JSON.parse(payload) as {
          type: string;
          vlogId: string;
          payload: unknown;
        };
        io.to(roomForVlog(event.vlogId)).emit(event.type as never, event.payload as never);
      } catch (err) {
        console.warn("[bridge] bad payload:", err);
      }
    });
    console.log("[vlogbuddy] listening for worker events");
  } catch (err) {
    console.error("[vlogbuddy] failed to subscribe to worker events:", err);
  }
}

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "0.0.0.0";

const app = next({ dev, hostname, port, dir: process.cwd() });
const handle = app.getRequestHandler();

/** Verifies the signed session cookie the same way the app does. */
function unsignCookie(signed: string, secret: string): string | null {
  const idx = signed.lastIndexOf(".");
  if (idx === -1) return null;
  const value = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);
  const expected = crypto.createHmac("sha256", secret).update(value).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

async function main() {
  await app.prepare();

  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");

  const server = createServer((req, res) => {
    handle(req, res, parse(req.url!, true));
  });

  const io = new SocketServer<ClientToServerEvents, ServerToClientEvents>(server, {
    path: "/api/socket",
    cors: {
      origin: process.env.PUBLIC_BASE_URL ?? true,
      credentials: true,
    },
    maxHttpBufferSize: 1e6,
  });

  // Expose to server actions so they can broadcast.
  (globalThis as Record<string, unknown>).__vlogbuddyIo = io;

  await bridgeWorkerEvents(io);

  /**
   * Authenticate the socket against the vlog's session cookie. Everything a
   * socket can do is scoped to the single vlog it authenticated for.
   */
  io.use(async (socket, nextFn) => {
    try {
      const vlogId = socket.handshake.auth?.vlogId as string | undefined;
      if (!vlogId) return nextFn(new Error("Missing vlogId"));

      const cookies = parseCookies(socket.handshake.headers.cookie);
      const raw = cookies[`vb_session_${vlogId.replace(/-/g, "")}`];
      if (!raw) return nextFn(new Error("Not a member of this vlog"));

      const token = unsignCookie(raw, secret);
      if (!token) return nextFn(new Error("Invalid session"));

      const [member] = await db
        .select()
        .from(members)
        .where(and(eq(members.vlogId, vlogId), eq(members.sessionToken, token)))
        .limit(1);

      if (!member) return nextFn(new Error("Not a member of this vlog"));

      socket.data.member = member;
      socket.data.vlogId = vlogId;
      nextFn();
    } catch (err) {
      nextFn(err instanceof Error ? err : new Error("Auth failed"));
    }
  });

  io.on("connection", (socket) => {
    const member = socket.data.member as { id: string; displayName: string };
    const vlogId = socket.data.vlogId as string;
    const room = roomForVlog(vlogId);

    void socket.join(room);

    const presence: PresenceMember = {
      memberId: member.id,
      displayName: member.displayName,
      color: colorForMember(member.id),
    };

    socket.to(room).emit("member:joined", presence);

    // Send whoever is already here.
    void (async () => {
      const sockets = await io.in(room).fetchSockets();
      const seen = new Map<string, PresenceMember>();
      for (const s of sockets) {
        const m = s.data.member as { id: string; displayName: string } | undefined;
        if (m) {
          seen.set(m.id, {
            memberId: m.id,
            displayName: m.displayName,
            color: colorForMember(m.id),
          });
        }
      }
      socket.emit("presence:sync", Array.from(seen.values()));
    })();

    socket.on("timeline:request", async () => {
      const [row] = await db.select().from(timelines).where(eq(timelines.vlogId, vlogId)).limit(1);
      socket.emit("timeline:sync", {
        timeline: row?.doc ?? emptyTimeline(),
        revision: row?.revision ?? 0,
      });
    });

    /**
     * Collaborative editing. The server is the source of truth: it applies the
     * op, bumps the revision and rebroadcasts. If a client was behind, it gets
     * the full document back so it can resync.
     */
    socket.on("timeline:op", async (payload, ack) => {
      try {
        if (payload.vlogId !== vlogId) {
          ack?.({ ok: false, error: "Wrong vlog" });
          return;
        }

        const parsed = timelineOpSchema.safeParse(payload.op);
        if (!parsed.success) {
          ack?.({ ok: false, error: "Invalid edit" });
          return;
        }

        const [vlog] = await db.select().from(vlogs).where(eq(vlogs.id, vlogId)).limit(1);
        if (!vlog || !["edit", "curate"].includes(vlog.state)) {
          ack?.({ ok: false, error: "The timeline is locked in this phase" });
          return;
        }

        const saved = await db.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(timelines)
            .where(eq(timelines.vlogId, vlogId))
            .for("update")
            .limit(1);

          const doc = current?.doc ?? emptyTimeline();
          const nextDoc = applyTimelineOp(doc, parsed.data);
          const nextRevision = (current?.revision ?? 0) + 1;

          const [row] = await tx
            .insert(timelines)
            .values({
              vlogId,
              doc: nextDoc,
              revision: nextRevision,
              updatedById: member.id,
            })
            .onConflictDoUpdate({
              target: timelines.vlogId,
              set: {
                doc: nextDoc,
                revision: nextRevision,
                updatedAt: new Date(),
                updatedById: member.id,
              },
            })
            .returning();

          return row;
        });

        socket.to(room).emit("timeline:op", {
          op: parsed.data,
          revision: saved.revision,
          byMemberId: member.id,
        });

        ack?.({ ok: true, revision: saved.revision, timeline: saved.doc });
      } catch (err) {
        console.error("[socket] timeline:op failed:", err);
        ack?.({ ok: false, error: "Edit failed" });
      }
    });

    socket.on("disconnect", () => {
      socket.to(room).emit("member:left", { memberId: member.id });
    });
  });

  server.listen(port, hostname, () => {
    console.log(`[vlogbuddy] ready on http://${hostname}:${port}`);
    console.log(`[vlogbuddy] public url: ${process.env.PUBLIC_BASE_URL ?? "(not set)"}`);
  });
}

main().catch((err) => {
  console.error("[vlogbuddy] failed to start:", err);
  process.exit(1);
});
