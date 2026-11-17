"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

interface Packet {
  edge: number;
  progress: number;
  speed: number;
}

// Mirrors the palette in tailwind.config.ts (signal.teal, signal.amber, ink.faint).
const COLORS = {
  node: "#3DDC97",
  edge: "#3DDC97",
  packet: "#E8A33D",
  core: "#7A5A22",
  ring: "#5C6478",
};

const SHELL_RADIUS = 1.7;
const PACKET_COUNT = 10;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

// Scratch objects reused every frame so the render loop doesn't allocate.
const dummy = new THREE.Object3D();
const edgeStart = new THREE.Vector3();
const edgeEnd = new THREE.Vector3();

/**
 * Decorative WebGL backdrop for the hero: a slowly turning network of nodes
 * with amber "requests" travelling along its edges, wrapped in a particle
 * ring. Renders nothing without WebGL, a single still frame under
 * prefers-reduced-motion, and stops rendering once scrolled out of view.
 */
export function HeroScene() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isSupported] = useState(hasWebGL);
  const [isReady, setIsReady] = useState(false);
  const prefersReducedMotion = useReducedMotion();
  const isInView = useInView(containerRef);

  if (!isSupported) return null;

  let frameloop: "always" | "demand" | "never" = "always";
  if (prefersReducedMotion) frameloop = "demand";
  else if (!isInView) frameloop = "never";

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 transition-opacity duration-1000 ${isReady ? "opacity-100" : "opacity-0"}`}
    >
      <Canvas
        camera={{ position: [0, 0, 7], fov: 45 }}
        dpr={[1, 1.75]}
        gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
        frameloop={frameloop}
        style={{ pointerEvents: "none" }}
        onCreated={() => setIsReady(true)}
      >
        <NetworkGraph isAnimated={!prefersReducedMotion} />
      </Canvas>
    </div>
  );
}

function NetworkGraph({ isAnimated }: { isAnimated: boolean }) {
  const motionRef = useRef<THREE.Group>(null);
  const shellRef = useRef<THREE.Group>(null);
  const coreRef = useRef<THREE.LineSegments>(null);
  const ringRef = useRef<THREE.Points>(null);
  const nodesRef = useRef<THREE.InstancedMesh>(null);
  const packetsRef = useRef<THREE.InstancedMesh>(null);
  const packetStateRef = useRef<Packet[] | null>(null);
  const pointerRef = usePointer(isAnimated);

  const viewportWidth = useThree((state) => state.viewport.width);
  const layout = getLayout(viewportWidth);

  const graph = useMemo(() => buildGraph(SHELL_RADIUS), []);
  const coreEdges = useMemo(() => new THREE.EdgesGeometry(new THREE.DodecahedronGeometry(0.8)), []);
  const ring = useMemo(() => buildRing(layout.isWide ? 700 : 350), [layout.isWide]);
  const dotTexture = useMemo(() => createDotTexture(), []);

  useEffect(() => {
    return () => {
      graph.edges.dispose();
      coreEdges.dispose();
      dotTexture.dispose();
    };
  }, [graph, coreEdges, dotTexture]);

  useEffect(() => () => ring.dispose(), [ring]);

  useFrame((state, delta) => {
    const motion = motionRef.current;
    const shell = shellRef.current;
    const core = coreRef.current;
    const ringPoints = ringRef.current;
    const nodes = nodesRef.current;
    const packets = packetsRef.current;
    if (!motion || !shell || !core || !ringPoints || !nodes || !packets) return;

    const time = isAnimated ? state.clock.elapsedTime : 0;
    const pointer = pointerRef.current;

    // Ease toward the pointer for a gentle parallax tilt, plus a slow float.
    motion.rotation.x = THREE.MathUtils.damp(motion.rotation.x, pointer.y * 0.25, 3, delta);
    motion.rotation.y = THREE.MathUtils.damp(motion.rotation.y, pointer.x * 0.35, 3, delta);
    motion.position.y = Math.sin(time * 0.6) * 0.08;

    shell.rotation.set(time * 0.05, time * 0.12, 0);
    core.rotation.set(0, -time * 0.25, time * 0.1);
    ringPoints.rotation.y = time * 0.04;

    graph.nodes.forEach((node, i) => {
      dummy.position.copy(node);
      dummy.scale.setScalar(1 + 0.35 * Math.sin(time * 2 + i * 1.7));
      dummy.updateMatrix();
      nodes.setMatrixAt(i, dummy.matrix);
    });
    nodes.instanceMatrix.needsUpdate = true;

    if (!isAnimated) return;

    packetStateRef.current ??= Array.from({ length: PACKET_COUNT }, () => createPacket(graph.edgeCount));
    const edgePositions = graph.edges.getAttribute("position");
    packetStateRef.current.forEach((packet, i) => {
      packet.progress += delta * packet.speed;
      if (packet.progress >= 1) Object.assign(packet, createPacket(graph.edgeCount));

      edgeStart.fromBufferAttribute(edgePositions, packet.edge * 2);
      edgeEnd.fromBufferAttribute(edgePositions, packet.edge * 2 + 1);
      dummy.position.lerpVectors(edgeStart, edgeEnd, packet.progress);
      // Fade in/out at the ends of each hop by scaling.
      dummy.scale.setScalar(Math.sin(packet.progress * Math.PI));
      dummy.updateMatrix();
      packets.setMatrixAt(i, dummy.matrix);
    });
    packets.instanceMatrix.needsUpdate = true;
  });

  return (
    <group position={[layout.x, layout.y, 0]} scale={layout.scale}>
      <group ref={motionRef}>
        <group ref={shellRef}>
          <lineSegments geometry={graph.edges}>
            <lineBasicMaterial color={COLORS.edge} transparent opacity={0.3} depthWrite={false} />
          </lineSegments>
          <instancedMesh ref={nodesRef} args={[undefined, undefined, graph.nodes.length]} frustumCulled={false}>
            <sphereGeometry args={[0.04, 12, 12]} />
            <meshBasicMaterial color={COLORS.node} />
          </instancedMesh>
          <instancedMesh
            ref={packetsRef}
            args={[undefined, undefined, PACKET_COUNT]}
            frustumCulled={false}
            visible={isAnimated}
          >
            <sphereGeometry args={[0.04, 8, 8]} />
            <meshBasicMaterial color={COLORS.packet} />
          </instancedMesh>
        </group>

        <lineSegments ref={coreRef} geometry={coreEdges}>
          <lineBasicMaterial color={COLORS.core} transparent opacity={0.8} depthWrite={false} />
        </lineSegments>

        <group rotation={[1.15, 0, 0.2]}>
          <points ref={ringRef} geometry={ring}>
            <pointsMaterial
              color={COLORS.ring}
              map={dotTexture}
              size={0.06}
              sizeAttenuation
              transparent
              opacity={0.8}
              depthWrite={false}
            />
          </points>
        </group>
      </group>
    </group>
  );
}

/**
 * Wide (two-column) hero: sit the graph to the right, behind the terminal
 * card. Narrow screens: center it behind the stacked content and shrink it
 * to fit the viewport width.
 */
function getLayout(viewportWidth: number) {
  const isWide = viewportWidth > 8;
  return {
    isWide,
    x: isWide ? viewportWidth * 0.25 : 0,
    y: 0,
    // The terminal card is wide, so the graph is scaled up to peek out around it.
    scale: isWide ? 1.2 : THREE.MathUtils.clamp(viewportWidth / 4.5, 0.5, 1),
  };
}

function buildGraph(radius: number) {
  const source = new THREE.IcosahedronGeometry(radius, 1);
  // A 1° threshold keeps every edge of the faceted sphere, deduplicated.
  const edges = new THREE.EdgesGeometry(source, 1);

  // The polyhedron geometry is non-indexed, so shared vertices repeat.
  const positions = source.getAttribute("position");
  const seen = new Set<string>();
  const nodes: THREE.Vector3[] = [];
  for (let i = 0; i < positions.count; i++) {
    const vertex = new THREE.Vector3().fromBufferAttribute(positions, i);
    const key = vertex
      .toArray()
      .map((n) => n.toFixed(3))
      .join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push(vertex);
  }
  source.dispose();

  return { edges, nodes, edgeCount: edges.getAttribute("position").count / 2 };
}

function buildRing(count: number) {
  const random = createRandom(42);
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const angle = random() * Math.PI * 2;
    const radius = 2.1 + random() * 0.6;
    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = (random() - 0.5) * 0.3;
    positions[i * 3 + 2] = Math.sin(angle) * radius;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geometry;
}

function createPacket(edgeCount: number): Packet {
  return {
    edge: Math.floor(Math.random() * edgeCount),
    progress: 0,
    speed: 0.4 + Math.random() * 0.5,
  };
}

/** Soft round sprite so the ring particles aren't drawn as squares. */
function createDotTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.5, "rgba(255,255,255,0.6)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  return new THREE.CanvasTexture(canvas);
}

/** Small seeded PRNG (mulberry32) so the particle ring is identical each load. */
function createRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hasWebGL() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * Tracks the pointer across the whole window (the canvas itself sits behind
 * the hero content and never receives pointer events), normalized to -1..1.
 */
function usePointer(isEnabled: boolean) {
  const pointerRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!isEnabled) return;
    function handlePointerMove(event: PointerEvent) {
      pointerRef.current.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointerRef.current.y = -((event.clientY / window.innerHeight) * 2 - 1);
    }
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", handlePointerMove);
  }, [isEnabled]);

  return pointerRef;
}

function useInView(ref: RefObject<HTMLElement>) {
  // Start "in view": the hero is above the fold on load.
  const [isInView, setIsInView] = useState(true);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setIsInView(entry?.isIntersecting ?? true));
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  return isInView;
}

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function useReducedMotion() {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false
  );
}
