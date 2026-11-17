"use client";

import dynamic from "next/dynamic";

// three.js only runs in the browser, and loading it lazily keeps it out of
// the initial bundle so the hero copy paints before the scene arrives.
export const HeroBackdrop = dynamic(() => import("@/components/three/HeroScene").then((mod) => mod.HeroScene), {
  ssr: false,
});
