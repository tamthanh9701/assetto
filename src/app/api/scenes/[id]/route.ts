import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const scene = await prisma.scene.findFirst({
    where: { id, project: { userId: session.user.id } },
  });
  if (!scene) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.scene.delete({ where: { id } });
  return NextResponse.json({ success: true });
}