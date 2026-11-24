// Fathom calls this when a recording is ready.
import { waitUntil } from "@vercel/functions";
import { verifyFathomSignature, claim, processMeeting } from "../lib/core.js";

export async function POST(request) {
  const raw = await request.text();
  try {
    if (!verifyFathomSignature(request.headers, raw)) return new Response("bad signature", { status: 401 });
    let payload;
    try { payload = JSON.parse(raw); } catch { return new Response("body is not JSON", { status: 400 }); }
    const meeting = payload.recording_id ? payload : payload.meeting || payload.data || payload;
    if (!meeting.recording_id) return new Response("no recording_id", { status: 200 });
    console.log("fathom webhook", meeting.recording_id, meeting.title);

    const pageId = await claim(meeting);
    if (!pageId) return new Response("already handled", { status: 200 });
    // Reply to Fathom straight away; the page is filled in the background.
    waitUntil(processMeeting(meeting, pageId).then((r) => console.log("done", JSON.stringify(r))).catch((e) => console.error("failed", e)));
    return new Response("accepted", { status: 202 });
  } catch (e) {
    console.error("fathom webhook failed", e.name === "SetupError" ? e.message : e);
    // Setup problems name the missing variable so the fix is obvious; they never include a value.
    return new Response(e.name === "SetupError" ? `setup problem: ${e.message}` : "error, see the function logs", { status: 500 });
  }
}

export function GET() {
  return new Response("call-to-tasks webhook is live");
}
