import { NextResponse } from "next/server";
import { db } from "../../../lib/db";

export async function GET(): Promise<NextResponse> {
  try {
    await db.query("SELECT 1");
    return NextResponse.json({ ok: true, service: "web" });
  } catch {
    return NextResponse.json({ ok: false, service: "web" }, { status: 503 });
  }
}
