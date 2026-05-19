import { redirect } from "next/navigation";
import { db } from "@/lib/db";

// Hits the DB and redirects on every request; never prerender as a static
// shell. Without this, `next build` tries to render at build time and fails
// with PrismaClientInitializationError because no DATABASE_URL is set.
export const dynamic = "force-dynamic";

export default async function Home() {
  const userCount = await db.user.count();
  if (userCount === 0) {
    redirect("/setup");
  }
  redirect("/dashboard");
}
