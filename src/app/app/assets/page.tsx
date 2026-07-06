import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Image as ImageIcon } from "lucide-react";

export default async function AssetsPage() {
  const session = await auth();
  const assets = await prisma.asset.findMany({
    where: { scene: { project: { userId: session?.user?.id } } },
    include: {
      scene: { select: { prompt: true } },
      componentGroup: { select: { name: true, type: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Assets</h1>
        <p className="text-muted-foreground">
          All your generated assets in one place.
        </p>
      </div>

      {assets.length === 0 ? (
        <Card className="text-center py-12">
          <CardContent>
            <ImageIcon className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
            <CardTitle className="mb-2">No assets yet</CardTitle>
            <p className="text-muted-foreground">
              Generate scenes and extract layers to see assets here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {assets.map((asset: any) => (
            <Card key={asset.id}>
              <CardContent className="p-3">
                <div className="aspect-square rounded-md overflow-hidden bg-muted mb-2">
                  {asset.pngUrl ? (
                    <img
                      src={asset.pngUrl}
                      alt={asset.name}
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                      <ImageIcon className="w-8 h-8" />
                    </div>
                  )}
                </div>
                <p className="text-sm font-medium truncate">{asset.name}</p>
                <div className="flex gap-1 mt-1 flex-wrap">
                  <Badge variant="secondary" className="text-xs">
                    {asset.componentGroup?.type || asset.type}
                  </Badge>
                  {asset.subType && (
                    <Badge variant="outline" className="text-xs">
                      {asset.subType}
                    </Badge>
                  )}
                  {asset.transparent && (
                    <Badge variant="outline" className="text-xs">
                      PNG
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
