import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function LandingPage() {
  return (
    <div className="flex-1">
      <header className="border-b">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500" />
            <span className="font-bold text-xl">TreAI Clone</span>
          </div>
          <nav className="flex items-center gap-4">
            <Link href="/auth/signin">
              <Button variant="ghost">Sign In</Button>
            </Link>
            <Link href="/auth/signup">
              <Button>Get Started</Button>
            </Link>
          </nav>
        </div>
      </header>

      <section className="py-20 text-center bg-gradient-to-b from-background to-muted">
        <div className="container mx-auto px-4 max-w-4xl">
          <h1 className="text-5xl font-bold tracking-tight mb-6">
            AI-Powered Game Asset Workspace
          </h1>
          <p className="text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
            Generate consistent game UI scenes and assets with AI. Extract layers,
            create component kits, and export transparent PNGs ready for Unity.
          </p>
          <div className="flex gap-4 justify-center">
            <Link href="/auth/signup">
              <Button size="lg" className="text-lg px-8">
                Start Creating Free
              </Button>
            </Link>
            <Link href="/auth/signin">
              <Button size="lg" variant="outline" className="text-lg px-8">
                Sign In
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <section className="py-20">
        <div className="container mx-auto px-4 max-w-6xl">
          <h2 className="text-3xl font-bold text-center mb-12">How It Works</h2>
          <div className="grid md:grid-cols-3 gap-8">
            <Card>
              <CardHeader>
                <div className="w-12 h-12 rounded-lg bg-purple-100 dark:bg-purple-900 flex items-center justify-center mb-4">
                  <span className="text-2xl font-bold text-purple-600">1</span>
                </div>
                <CardTitle>Direct the Scene</CardTitle>
                <CardDescription>
                  Describe your game UI scene, choose type and style. AI generates multiple variations.
                </CardDescription>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <div className="w-12 h-12 rounded-lg bg-pink-100 dark:bg-pink-900 flex items-center justify-center mb-4">
                  <span className="text-2xl font-bold text-pink-600">2</span>
                </div>
                <CardTitle>Extract Layers</CardTitle>
                <CardDescription>
                  Automatically separate backgrounds, panels, buttons, icons, and badges into reusable components.
                </CardDescription>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <div className="w-12 h-12 rounded-lg bg-blue-100 dark:bg-blue-900 flex items-center justify-center mb-4">
                  <span className="text-2xl font-bold text-blue-600">3</span>
                </div>
                <CardTitle>Export & Use</CardTitle>
                <CardDescription>
                  Download individual PNGs or grouped assets with transparent backgrounds, ready for Unity.
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
        </div>
      </section>

      <section className="py-20 bg-muted">
        <div className="container mx-auto px-4 max-w-6xl">
          <h2 className="text-3xl font-bold text-center mb-12">Features</h2>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              { title: "Style Memory", desc: "Consistent art direction and palette across all your scenes." },
              { title: "Component Extraction", desc: "Turn a full screen into a reusable UI kit automatically." },
              { title: "Transparent PNG", desc: "Export assets with transparent backgrounds ready for game engines." },
              { title: "Multiple Providers", desc: "Works with Replicate, Gemini, OpenAI, or custom AI models." },
              { title: "Project Management", desc: "Organize scenes and assets by project with style memory." },
              { title: "Batch Export", desc: "Download single assets or entire component groups as ZIP." },
            ].map((feature) => (
              <Card key={feature.title}>
                <CardHeader>
                  <CardTitle className="text-lg">{feature.title}</CardTitle>
                  <CardDescription>{feature.desc}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t py-8 text-center text-sm text-muted-foreground">
        <div className="container mx-auto px-4">
          <p>Built with Next.js, Tailwind CSS, and shadcn/ui</p>
        </div>
      </footer>
    </div>
  );
}