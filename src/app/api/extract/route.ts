import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { sceneId, imageUrl } = await req.json();
  if (!sceneId || !imageUrl) {
    return NextResponse.json({ error: "sceneId and imageUrl required" }, { status: 400 });
  }

  const scene = await prisma.scene.findFirst({
    where: { id: sceneId, project: { userId: session.user.id } },
  });
  if (!scene) return NextResponse.json({ error: "Scene not found" }, { status: 404 });

  const componentNames = ["Background", "Panel", "Button", "Icon", "Badge", "Bar"];
  const componentTypes = ["BACKGROUND", "PANEL", "BUTTON", "ICON", "BADGE", "BAR"];

  const components = [];
  for (let i = 0; i < componentNames.length; i++) {
    const group = await prisma.componentGroup.create({
      data: {
        name: componentNames[i],
        type: componentTypes[i] as any,
        order: i,
        sceneId,
      },
    });

    const asset = await prisma.asset.create({
      data: {
        name: `${componentNames[i]}_${sceneId.slice(0, 6)}`,
        type: "COMPONENT",
        pngUrl: imageUrl,
        transparent: true,
        componentGroupId: group.id,
        sceneId,
      },
    });

    components.push({ name: group.name, type: group.type, imageUrl: asset.pngUrl });
  }

  return NextResponse.json({ components });
}