import {
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { PDFDocument, rgb, LineCapStyle } from "pdf-lib";
import {
  ArrowDownToLine, Check, ChevronLeft, ChevronRight, CircleHelp, Cloud,
  Download, Eraser, FilePlus2, FileText, FolderOpen, HardHat, Highlighter, Layers3,
  Maximize2, Menu, MousePointer2, PenLine, RotateCcw, RotateCw, Ruler, Save,
  ScanSearch, ShieldCheck, TextCursorInput, Trash2, Type, Upload, X,
  Minus, Pentagon, ClipboardList, Scaling,
} from "lucide-react";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

// ─── pdfjs loader ─────────────────────────────────────────────────────────────
// pdfjs-dist is large (~800 KB). We lazy-load it on first use so the landing
// page renders immediately on slow connections / old hardware.
let _pdfjsLib: typeof import("pdfjs-dist") | null = null;
async function getPdfjs() {
  if (_pdfjsLib) return _pdfjsLib;
  const lib = await import("pdfjs-dist");
  // pdfjs-dist v3 ships a classic CJS worker — works on Chrome 60+ / Windows 7.
  // Vite bundles the worker locally at build time via the new URL() pattern.
  lib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.js",
    import.meta.url,
  ).href;
  _pdfjsLib = lib;
  return lib;
}

// ─── Types ────────────────────────────────────────────────────────────────────
type Tool = "select" | "pen" | "highlight" | "eraser" | "text" | "line" | "dimension" | "area" | "setscale";

type ScaleChip = {
  id: string;
  raw: string;       // display text e.g. '1/4" = 1\'-0"' or '1:100'
  scale: number;     // normDist per foot (our internal unit)
  unit: "imperial" | "metric";
};

type Pt = { x: number; y: number };

type Markup = {
  id: string;
  page: number;
  kind: "path" | "text" | "line" | "dimension" | "area";
  // freehand path
  points?: Pt[];
  // line / dimension
  a?: Pt;
  b?: Pt;
  label?: string;
  // text
  text?: string;
  x?: number;
  y?: number;
  // area polygon
  polygon?: Pt[];
  sqFt?: number;
  adjustedSqFt?: number;   // roof areas only — sqFt × slope multiplier
  slopePitch?: string;     // roof areas only — e.g. "6:12"
  category?: string;
  categoryColor?: string;
  // common
  color: string;
  width: number;
  opacity: number;
};

// Normalized text item extracted from a vector PDF page
type PdfTextItem = {
  str: string;
  x: number;      // 0–1 fraction of page width (baseline left edge)
  y: number;      // 0–1 fraction of page height, top-down (baseline)
  fs: number;     // font size as fraction of page height
  angle: number;  // rotation in radians
};

// ─── Constants ────────────────────────────────────────────────────────────────
const defaultInk = "#1b78b7";
const colors = ["#1b78b7", "#173a59", "#d06441", "#e2a72f", "#2b8b70", "#7e5ba6"];
const NODE_SIZE = 3;
const NODE_RADIUS = NODE_SIZE / 2;

const toolMeta: { id: Tool; label: string; shortcut: string; icon: typeof MousePointer2; group: "markup" | "precision" | "utility" }[] = [
  { id: "select",    label: "Select",     shortcut: "V", icon: MousePointer2,   group: "markup"    },
  { id: "pen",       label: "Pen",        shortcut: "P", icon: PenLine,         group: "markup"    },
  { id: "highlight", label: "Highlight",  shortcut: "H", icon: Highlighter,     group: "markup"    },
  { id: "eraser",    label: "Eraser",     shortcut: "E", icon: Eraser,          group: "markup"    },
  { id: "text",      label: "Text note",  shortcut: "T", icon: TextCursorInput, group: "markup"    },
  { id: "line",      label: "Line",       shortcut: "L", icon: Minus,           group: "precision" },
  { id: "dimension", label: "Dimension",  shortcut: "D", icon: Ruler,           group: "precision" },
  { id: "area",      label: "Area",       shortcut: "A", icon: Pentagon,        group: "precision" },
];

const areaCategories = [
  { id: "basement", label: "Basement",    color: "#6b7280" },
  { id: "main",     label: "Main Floor",  color: "#1b78b7" },
  { id: "upper",    label: "Upper Floor", color: "#2b8b70" },
  { id: "garage",   label: "Garage",      color: "#7e5ba6" },
  { id: "deck",     label: "Deck / Patio",color: "#e2a72f" },
  { id: "roof",     label: "Roof",        color: "#d06441" },
  { id: "other",    label: "Other",       color: "#173a59" },
];

const elevationCategories = [
  { id: "fibre-cement", label: "Concrete / Fibre Cement", color: "#1b78b7" },
  { id: "vinyl",        label: "Vinyl Siding",            color: "#2b8b70" },
  { id: "brick",        label: "Brick Veneer",            color: "#d06441" },
  { id: "board-batten", label: "Board & Batten",          color: "#7e5ba6" },
  { id: "stucco",       label: "Stucco",                  color: "#e2a72f" },
  { id: "elev-other",   label: "Other",                   color: "#173a59" },
];

// Combined lookup used by commitArea and the schedule
const allAreaCategories = [...areaCategories, ...elevationCategories];

// ─── Roof pitch helpers ───────────────────────────────────────────────────────
const ROOF_PITCHES = [
  { label: "2:12", rise: 2 }, { label: "3:12", rise: 3 }, { label: "4:12", rise: 4 },
  { label: "5:12", rise: 5 }, { label: "6:12", rise: 6 }, { label: "7:12", rise: 7 },
  { label: "8:12", rise: 8 }, { label: "9:12", rise: 9 }, { label: "10:12", rise: 10 },
  { label: "12:12", rise: 12 },
];
function slopeMultiplier(rise: number) { return Math.sqrt(1 + (rise / 12) ** 2); }
function detectPitch(text: string): string | null {
  // Match patterns like "4:12", "4/12", "4 in 12", "4-12 pitch"
  const m = text.match(/\b(\d+)\s*(?::|\/|in|-)\s*12\b/i);
  if (!m) return null;
  const rise = parseInt(m[1]);
  const match = ROOF_PITCHES.find((p) => p.rise === rise);
  return match ? match.label : null;
}

function detectSheetType(text: string): "plan" | "elevation" {
  const t = text.toUpperCase();
  const elevScore = (t.match(/\bELEVATION\b|\bELEV\b/g) ?? []).length
    + (t.match(/\b(FRONT|REAR|LEFT SIDE|RIGHT SIDE|NORTH|SOUTH|EAST|WEST)\s+(ELEV|ELEVATION)\b/g) ?? []).length * 2;
  const planScore  = (t.match(/\bFLOOR\s+PLAN\b|\bSITE\s+PLAN\b|\bROOF\s+PLAN\b|\bFOUNDATION\b|\bMAIN\s+FLOOR\b|\bUPPER\s+FLOOR\b/g) ?? []).length;
  return elevScore > planScore ? "elevation" : "plan";
}

function parseFraction(s: string): number {
  if (s.includes("/")) { const [n, d] = s.split("/").map(Number); return d ? n / d : 0; }
  return parseFloat(s) || 0;
}

/** Returns true for strings that look like architectural dimensions or measurements. */
function isDimension(s: string): boolean {
  const t = s.trim();
  if (t.length === 0 || t.length > 16) return false;
  // Foot / inch notation: 2'-6", 14', 3", 1'-0 1/2", 2' - 6", etc.
  if (/\d\s*['\u2019]/.test(t) || /\d\s*["\u201d]/.test(t)) return true;
  // Fractional inch: 3/4, 1 1/2, 3-1/2  (no letters)
  if (/^\d+[\s-]+\d+\/\d+$/.test(t) || /^\d+\/\d+$/.test(t)) return true;
  // Standalone integer 1–4 digits (common dimension callouts like "14" or "6")
  if (/^\d{1,4}$/.test(t)) return true;
  return false;
}

/** Point-in-polygon (ray casting). */
function pointInPolygon(pt: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > pt.y) !== (yj > pt.y)) && pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/** Minimum distance from pt to line segment a→b (in SVG units). */
function distToSegment(pt: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(pt.x - a.x, pt.y - a.y);
  const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq));
  return Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
}

function makeId() { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
function formatSize(b: number) { return `${(b / 1024 / 1024).toFixed(b < 1048576 ? 2 : 1)} MB`; }

function applyShiftSnap(anchor: Pt, pt: Pt, snap: boolean, step = Math.PI / 4, locked: number | null = null): Pt {
  if (!snap) return pt;
  const dx = pt.x - anchor.x, dy = pt.y - anchor.y;
  if (locked !== null) {
    // Signed projection onto the locked axis: works in both directions along the axis
    // and is immune to perpendicular cursor movement.
    const proj = dx * Math.cos(locked) + dy * Math.sin(locked);
    return { x: anchor.x + proj * Math.cos(locked), y: anchor.y + proj * Math.sin(locked) };
  }
  const dist = Math.hypot(dx, dy);
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: anchor.x + dist * Math.cos(angle), y: anchor.y + dist * Math.sin(angle) };
}

/** Normalised distance in page-proportion space, accounts for page aspect ratio. */
function normDist(a: Pt, b: Pt, pageAspect: number): number {
  return Math.hypot((b.x - a.x) / 1000, ((b.y - a.y) / 1000) * pageAspect);
}

function formatFtIn(feet: number): string {
  const fInt = Math.floor(feet);
  const inches = Math.round((feet - fInt) * 12);
  if (inches === 12) return `${fInt + 1}'-0"`;
  return `${fInt}'-${inches}"`;
}

/** Break feet into ft + inch string with 1/16" resolution for the dim bar. */
function ftInParts(feet: number): { ft: number; inStr: string } {
  const ft = Math.floor(feet);
  const totalIn = (feet - ft) * 12;
  const wholeIn = Math.floor(totalIn);
  let sixteenths = Math.round((totalIn - wholeIn) * 16);
  let extraIn = 0;
  if (sixteenths === 16) { sixteenths = 0; extraIn = 1; }
  const wi = wholeIn + extraIn;
  if (sixteenths === 0) return { ft, inStr: `${wi}` };
  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
  const g = gcd(sixteenths, 16);
  return { ft, inStr: wi > 0 ? `${wi} ${sixteenths/g}/${16/g}` : `${sixteenths/g}/${16/g}` };
}

/** Parse an inch string like "6 1/16" or "6.5" → decimal inches. */
function parseInchStr(s: string): number {
  const parts = s.trim().split(/\s+/);
  const whole = parseFloat(parts[0]) || 0;
  if (parts.length === 1) return whole;
  if (parts[1]?.includes("/")) {
    const [n, d] = parts[1].split("/").map(Number);
    return whole + (d ? n / d : 0);
  }
  return whole + (parseFloat(parts[1]) || 0);
}

function measureDistance(a: Pt, b: Pt, pageAspect: number, scale: number | null): string {
  if (!scale) return "Set scale first";
  return formatFtIn(normDist(a, b, pageAspect) / scale);
}

function polygonSqFt(pts: Pt[], pageAspect: number, scale: number): number {
  const n = pts.map((p) => ({ x: p.x / 1000, y: (p.y / 1000) * pageAspect }));
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    const a = n[i], b = n[(i + 1) % n.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2 / (scale * scale);
}

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace("#", ""), 16);
  return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
}

// ─── App shell ────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <ErrorBoundary resetKey="root">
      <TooltipProvider>
        <Home />
        <Toaster />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

// ─── Main workspace ───────────────────────────────────────────────────────────
function Home() {
  // PDF state
  const [pdfDoc,     setPdfDoc]     = useState<PDFDocumentProxy | null>(null);
  const [pdfBytes,   setPdfBytes]   = useState<Uint8Array | null>(null);
  const [fileName,   setFileName]   = useState("");
  const [fileSize,   setFileSize]   = useState(0);
  const [pageCount,  setPageCount]  = useState(0);
  const [pageAspects, setPageAspects] = useState<Record<number, number>>({});  // pageNum → h/w
  const [pageAspect, setPageAspect] = useState(1.294);

  // Workspace state
  const [markup,     setMarkup]     = useState<Markup[]>([]);
  const [history,    setHistory]    = useState<Markup[][]>([]);
  const [future,     setFuture]     = useState<Markup[][]>([]);
  const [tool,       setTool]       = useState<Tool>("pen");
  const [color,      setColor]      = useState(defaultInk);
  const [thickness,  setThickness]  = useState(4);
  const [page,       setPage]       = useState(1);
  const [isLoading,  setIsLoading]  = useState(false);
  const [error,      setError]      = useState("");
  const [toast,      setToast]      = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileTools,setMobileTools]= useState(false);
  const [pagesExpanded, setPagesExpanded] = useState(false);
  // Box zoom — Z and X are independent zoom windows
  type ZoomBox = { x1: number; y1: number; x2: number; y2: number };
  const [zoomBoxZ,       setZoomBoxZ]       = useState<ZoomBox | null>(null); // Z key zoom box
  const [zoomBoxX,       setZoomBoxX]       = useState<ZoomBox | null>(null); // X key zoom box
  const [activeZoom,     setActiveZoom]     = useState<'z'|'x'|null>(null);  // which is currently shown
  const [stagePx,        setStagePx]        = useState<{ w: number; h: number } | null>(null); // computed pixel size
  const [zoomDrawing,    setZoomDrawing]    = useState(false);
  const [zoomDrawTarget, setZoomDrawTarget] = useState<'z'|'x'>('z'); // which box is being drawn
  const [zoomDrawStart,  setZoomDrawStart]  = useState<Pt | null>(null); // drag anchor
  const [zoomCorner1,    setZoomCorner1]    = useState<Pt | null>(null); // first click corner
  const [shiftHeld,  setShiftHeld]  = useState(false);
  const [ctrlHeld,   setCtrlHeld]   = useState(false);
  const [lockedAngle,setLockedAngle]= useState<number | null>(null);
  const [customAngleLock, setCustomAngleLock] = useState<number | null>(null); // L/R exact-angle lock
  // Dimension bar
  const [dimFt,      setDimFt]      = useState("");
  const [dimIn,      setDimIn]      = useState("");
  const [dimEditing, setDimEditing] = useState(false);
  const ftInputRef = useRef<HTMLInputElement>(null);
  const inInputRef = useRef<HTMLInputElement>(null);

  // Precision tools state — scale is per-page, derived from chips
  const [pageScaleChips, setPageScaleChips] = useState<Record<number, ScaleChip[]>>({});
  const [activeChipId,   setActiveChipId]   = useState<Record<number, string>>({});
  const [pageWidthPt,    setPageWidthPt]    = useState<Record<number, number>>({});
  const [pageSheetType,  setPageSheetType]  = useState<Record<number, "plan" | "elevation">>({});
  const [lineAnchor,   setLineAnchor]   = useState<Pt | null>(null);
  const [areaPoints,   setAreaPoints]   = useState<Pt[]>([]);
  const [mousePos,     setMousePos]     = useState<Pt | null>(null);
  const [pendingPoly,  setPendingPoly]  = useState<Pt[] | null>(null);
  const [showCatPicker,setShowCatPicker]= useState(false);
  const [pickerSheetType, setPickerSheetType] = useState<"plan" | "elevation">("plan");
  const [showPitchPicker, setShowPitchPicker] = useState(false);
  const [selectedPitch,   setSelectedPitch]   = useState("6:12");
  const [pendingSqFt,     setPendingSqFt]     = useState(0);
  const [pageRoofPitch,   setPageRoofPitch]   = useState<Record<number, string>>({});
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleNotes, setScheduleNotes] = useState("");
  type ScannedSchedule = {
    doors: { key: string; count: number }[];
    windows: { key: string; count: number }[];
    garageDoors: { key: string; count: number }[];
    scanning: boolean;
  };
  const [scannedSchedule, setScannedSchedule] = useState<ScannedSchedule | null>(null);

  // Scale calibration
  const [scaleModeStep, setScaleModeStep] = useState<0 | 1 | 2>(0);
  const [scaleAnchor,   setScaleAnchor]   = useState<Pt | null>(null);
  const [scaleEnd,      setScaleEnd]      = useState<Pt | null>(null);
  const [scaleFt,       setScaleFt]       = useState("");
  const [scaleIn,       setScaleIn]       = useState("");

  // Text overlay (vector PDF text at 2× size)
  const [pageTextItems,    setPageTextItems]    = useState<Record<number, PdfTextItem[]>>({});
  const [showTextOverlay,  setShowTextOverlay]  = useState(false);

  // Magnifying loupe — 0=off, 1=normal (220px 3.5×), 2=large (320px 4.5×)
  const [loupeStage, setLoupeStage] = useState<0 | 1 | 2>(0);

  // Export
  const [showExport,  setShowExport]  = useState(false);
  const [exportType,  setExportType]  = useState<"vector" | "flattened">("vector");
  const [exportRange, setExportRange] = useState<"all" | "selected">("all");
  const [dpi,         setDpi]         = useState<"150" | "300">("150");

  // Refs
  const fileInputRef       = useRef<HTMLInputElement>(null);
  const stageRef           = useRef<HTMLDivElement>(null);
  const stageContainerRef  = useRef<HTMLDivElement>(null);
  const pdfCanvasRef  = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const drawingRef    = useRef<Markup | null>(null);
  // Mutable refs so keydown handler always reads fresh values without re-registering
  const mousePosRef   = useRef<Pt | null>(null);
  const lineAnchorRef = useRef<Pt | null>(null);
  const areaPointsRef = useRef<Pt[]>([]);
  const ctrlHeldRef   = useRef(false);
  const shiftHeldRef  = useRef(false);
  const toolRef       = useRef(tool);
  const lineEffectiveExistingRef = useRef<Pt | null>(null);
  const zoomBoxZRef        = useRef<ZoomBox | null>(null);
  const zoomBoxXRef        = useRef<ZoomBox | null>(null);
  const activeZoomRef      = useRef<'z'|'x'|null>(null);
  const zoomDrawingRef     = useRef(false);
  const customAngleLockRef = useRef<number | null>(null);
  const lockedAngleRef     = useRef<number | null>(null);
  const liveTargetRef      = useRef<Pt | null>(null);
  const snapHoldRef        = useRef<Pt | null>(null); // hysteresis: keeps last snap until cursor exits wider radius
  const loupeCanvasRef     = useRef<HTMLCanvasElement>(null);
  const sessionInputRef    = useRef<HTMLInputElement>(null);
  // Select-mode drag refs (avoid stale closures in pointer handlers)
  const dragAnchorRef  = useRef<Pt | null>(null);
  const selectedIdRef  = useRef<string | null>(null);
  const [dragOffset,     setDragOffset]     = useState<{ x: number; y: number } | null>(null);
  const [editingAreaId,  setEditingAreaId]  = useState<string | null>(null);

  // Memoized so pointer-move re-renders don't rebuild the markup array / SVG
  const pageMarkup = useMemo(() => markup.filter((m) => m.page === page), [markup, page]);
  const snap45 = shiftHeld || ctrlHeld;
  const snapStep = ctrlHeld && shiftHeld ? Math.PI / 8   // 22.5°
                 : shiftHeld            ? Math.PI / 6   // 30°
                 :                        Math.PI / 4;  // 45°
  const currentSnap = (pt: Pt, anchor: Pt) => applyShiftSnap(anchor, pt, snap45, snapStep, lockedAngle);

  // Keep mutable refs in sync with latest state (read by keydown without stale closures)
  mousePosRef.current   = mousePos;
  lineAnchorRef.current = lineAnchor;
  areaPointsRef.current = areaPoints;
  ctrlHeldRef.current   = ctrlHeld;
  shiftHeldRef.current  = shiftHeld;
  toolRef.current       = tool;
  zoomBoxZRef.current        = zoomBoxZ;
  zoomBoxXRef.current        = zoomBoxX;
  activeZoomRef.current      = activeZoom;
  zoomDrawingRef.current     = zoomDrawing;
  customAngleLockRef.current = customAngleLock;
  lockedAngleRef.current     = lockedAngle;
  selectedIdRef.current      = selectedId;
  // Updated after lineEffectiveExisting is computed (below) — see sync after snap block

  // ── Snap to existing endpoints / vertices ────────────────────────────────────
  // Keep snap targets precise: these values are in the SVG's 0–1000 coordinate
  // space, which maps to roughly one pixel per unit at the normal canvas size.
  const SNAP_EXISTING_PX = 3;
  const SNAP_PROJECT_PERP = 3; // perpendicular tolerance for locked-axis projection
  // Memoized — only recomputed when markup changes, not on every pointer-move render
  const existingPoints = useMemo((): Pt[] => {
    const pts: Pt[] = [];
    for (const m of pageMarkup) {
      if ((m.kind === "line" || m.kind === "dimension") && m.a && m.b) {
        pts.push(m.a, m.b);
      } else if (m.kind === "area" && m.polygon) {
        pts.push(...m.polygon);
      }
    }
    return pts;
  }, [pageMarkup]);
  function nearestExisting(pt: Pt): Pt | null {
    let best: Pt | null = null;
    let bestDist = SNAP_EXISTING_PX;
    for (const ep of existingPoints) {
      const d = Math.hypot(ep.x - pt.x, ep.y - pt.y);
      if (d < bestDist) { best = ep; bestDist = d; }
    }
    return best;
  }
  function snapExisting(pt: Pt): Pt { return nearestExisting(pt) ?? pt; }

  // When direction-locked, only accept an existing snap point if it is ON the locked
  // axis (perpendicular distance < threshold). Returns the projection onto the axis
  // so the click lands exactly on the locked line. Returns null if off-axis.
  function filterExistingToAxis(snapPt: Pt | null, anchor: Pt, angle: number): Pt | null {
    if (!snapPt) return null;
    const cosA = Math.cos(angle), sinA = Math.sin(angle);
    const perpDist = Math.abs(-(snapPt.x - anchor.x) * sinA + (snapPt.y - anchor.y) * cosA);
    if (perpDist > SNAP_EXISTING_PX) return null; // off-axis — direction lock wins
    const dot = (snapPt.x - anchor.x) * cosA + (snapPt.y - anchor.y) * sinA;
    return { x: anchor.x + dot * cosA, y: anchor.y + dot * sinA };
  }

  // When direction-locked, find the nearest existing point whose projection onto
  // the locked axis is within SNAP_EXISTING_PX of the current mouse position.
  // Returns { snapped: Pt, source: Pt } — snapped is the point on the locked line,
  // source is the original existing point (used to draw the reference line).
  function nearestProjectedOnLocked(anchor: Pt, angle: number, mousePt: Pt): { snapped: Pt; source: Pt } | null {
    const cosA = Math.cos(angle), sinA = Math.sin(angle);
    // Mouse's distance along the locked axis from anchor
    const mouseDot = (mousePt.x - anchor.x) * cosA + (mousePt.y - anchor.y) * sinA;
    let best: { snapped: Pt; source: Pt } | null = null;
    let bestDist = SNAP_EXISTING_PX;
    for (const ep of existingPoints) {
      // Perpendicular distance from ep to the locked line
      const perpDist = Math.abs(-(ep.x - anchor.x) * sinA + (ep.y - anchor.y) * cosA);
      if (perpDist > SNAP_PROJECT_PERP) continue;
      // How far along the locked axis does ep project?
      const epDot = (ep.x - anchor.x) * cosA + (ep.y - anchor.y) * sinA;
      // Distance between mouse position and this projection (along the axis)
      const d = Math.abs(mouseDot - epDot);
      if (d < bestDist) {
        bestDist = d;
        best = {
          snapped: { x: anchor.x + epDot * cosA, y: anchor.y + epDot * sinA },
          source: ep,
        };
      }
    }
    return best;
  }

  // Derived scale for the current page — null if no chip is active
  const scale: number | null = (() => {
    const chips = pageScaleChips[page] ?? [];
    const id = activeChipId[page];
    return chips.find((c) => c.id === id)?.scale ?? null;
  })();

  // ── Shift / Ctrl tracking + direction lock ──────────────────────────────────
  useEffect(() => {
    function lockAngle(newCtrl: boolean, newShift: boolean) {
      const t = toolRef.current;
      if (t !== "line" && t !== "dimension" && t !== "area") return;
      const anchor = lineAnchorRef.current
        ?? (areaPointsRef.current.length > 0 ? areaPointsRef.current[areaPointsRef.current.length - 1] : null);
      const mp = mousePosRef.current;
      if (!anchor || !mp) return;
      const step = newCtrl && newShift ? Math.PI / 8 : newShift ? Math.PI / 6 : Math.PI / 4;
      const dx = mp.x - anchor.x, dy = mp.y - anchor.y;
      setLockedAngle(Math.round(Math.atan2(dy, dx) / step) * step);
    }

    const dn = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        shiftHeldRef.current = true;
        setShiftHeld(true);
        // Don't re-snap lockedAngle while an explicit L/R lock is active
        if (customAngleLockRef.current === null) lockAngle(ctrlHeldRef.current, true);
      }
      if (e.key === "Control") {
        ctrlHeldRef.current = true;
        setCtrlHeld(true);
        if (customAngleLockRef.current === null) lockAngle(true, shiftHeldRef.current);
      }
      // Alt held on full-screen → show loupe (zoom viewports use Alt for scroll-zoom instead)
      if (e.key === "Alt" && !activeZoomRef.current) {
        e.preventDefault(); // prevent browser menu bar focus
        setLoupeStage((s) => s === 0 ? 1 : s);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Shift") { shiftHeldRef.current = false; setShiftHeld(false); }
      if (e.key === "Control") { ctrlHeldRef.current = false; setCtrlHeld(false); }
      // Don't clear lockedAngle while an explicit L/R lock is active — releasing
      // Shift/Ctrl while typing in the length box must not disturb the locked direction.
      if (!ctrlHeldRef.current && !shiftHeldRef.current && customAngleLockRef.current === null) {
        setLockedAngle(null);
      }
      // Alt released → always hide loupe
      if (e.key === "Alt") setLoupeStage(0);
    };
    window.addEventListener("keydown", dn);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", dn); window.removeEventListener("keyup", up); };
  }, []);

  // ── Live dimension bar update ─────────────────────────────────────────────────
  // Uses liveTargetRef (set during render) so the displayed distance always matches
  // the visual preview line — including node-snap and axis-projection corrections.
  useEffect(() => {
    if (dimEditing) return;
    const anchor = (tool === "line" || tool === "dimension") ? lineAnchor
      : (tool === "area" && areaPoints.length > 0) ? areaPoints[areaPoints.length - 1] : null;
    const target = liveTargetRef.current;
    if (!anchor || !target || !scale) { setDimFt(""); setDimIn(""); return; }
    const feet = normDist(anchor, target, pageAspect) / scale;
    if (feet <= 0) { setDimFt("0"); setDimIn("0"); return; }
    const { ft, inStr } = ftInParts(feet);
    setDimFt(String(ft));
    setDimIn(inStr);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mousePos, lineAnchor, areaPoints, scale, tool, shiftHeld, ctrlHeld, customAngleLock, pageAspect]);

  // ── localStorage ───────────────────────────────────────────────────────────
  useEffect(() => {
    try {
      const saved = localStorage.getItem("pdf-markup-studio-markup");
      if (saved) setMarkup(JSON.parse(saved) as Markup[]);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem("pdf-markup-studio-markup", JSON.stringify(markup)); } catch { /* full */ }
  }, [markup]);

  // ── Stage pixel sizing — ResizeObserver keeps aspect ratio exact ────────────
  useEffect(() => {
    const el = stageContainerRef.current;
    if (!el) return;
    const compute = () => {
      const { width: cw, height: ch } = el.getBoundingClientRect();
      if (!cw || !ch) return;
      // "contain" logic: largest rectangle with ratio 1:pageAspect that fits in cw×ch
      let w = cw;
      let h = w * pageAspect;
      if (h > ch) { h = ch; w = h / pageAspect; }
      setStagePx({ w: Math.floor(w), h: Math.floor(h) });
    };
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    compute();
    return () => ro.disconnect();
  }, [pageAspect]);

  // ── Render PDF page + auto-detect scale ─────────────────────────────────────
  useEffect(() => {
    if (!pdfDoc || !pdfCanvasRef.current) return;
    renderTaskRef.current?.cancel();
    let cancelled = false;
    (async () => {
      try {
        const pdfPage = await pdfDoc.getPage(page);
        if (cancelled) return;

        // Render
        const canvas = pdfCanvasRef.current!;
        const ctx = canvas.getContext("2d")!;
        // 1.5× renders at 56% of the pixel count vs 2× — much lighter on old GPUs
        // while still looking sharp at normal zoom levels.
        const scale2 = 1.5;
        const vp = pdfPage.getViewport({ scale: scale2 });
        canvas.width = vp.width; canvas.height = vp.height;
        setPageAspect(vp.height / vp.width);
        const task = pdfPage.render({ canvasContext: ctx, viewport: vp, canvas });
        renderTaskRef.current = task;

        // Auto-detect scale from PDF text + build text overlay items (run in parallel with render)
        if (pageScaleChips[page] === undefined || pageTextItems[page] === undefined) {
          void (async () => {
            try {
              const vp1 = pdfPage.getViewport({ scale: 1 });
              const W = vp1.width; // page width in PDF points (1pt = 1/72 inch)
              const H = vp1.height;
              setPageWidthPt((prev) => ({ ...prev, [page]: W }));
              const content = await pdfPage.getTextContent();
              const rawItems = content.items as Array<{ str: string; transform: number[]; width: number; height: number }>;

              // Build normalized text items for the overlay
              const textItems: PdfTextItem[] = rawItems
                .filter((it) => it.str.trim().length > 0)
                .map((it) => {
                  const [a, b, , , e, f] = it.transform;
                  const fs = Math.sqrt(a * a + b * b) / H;  // font size as fraction of page height
                  const x = e / W;
                  const y = 1 - f / H;                      // flip: PDF y is bottom-up
                  const angle = Math.atan2(b, a);
                  return { str: it.str, x, y, fs, angle };
                })
                .filter((it) => it.fs > 0.002 && it.fs < 0.15); // discard invisibly small or huge outliers
              setPageTextItems((prev) => ({ ...prev, [page]: textItems }));

              const text = rawItems.map((it) => it.str).join(" ");
              if (pageScaleChips[page] === undefined) {
                const chips: ScaleChip[] = [];
                const seen = new Set<string>();
                // Imperial: 1/4" = 1'-0"
                const fracRe = /(\d+\/\d+|\d+)\s*"\s*=\s*(\d+)\s*['\u2019]\s*-?\s*(\d+)?["\u201d]?/gi;
                let m: RegExpExecArray | null;
                while ((m = fracRe.exec(text))) {
                  const val = parseFraction(m[1]);
                  const feet = parseInt(m[2], 10) || 0;
                  const inches = m[3] ? parseInt(m[3], 10) : 0;
                  const totalInches = feet * 12 + inches;
                  if (!val || !totalInches) continue;
                  const raw = `${m[1]}" = ${feet}'-${inches}"`;
                  if (seen.has(raw)) continue;
                  seen.add(raw);
                  const ratio = totalInches / val; // real inches per paper inch
                  chips.push({ id: `p${page}-${chips.length}`, raw, scale: 864 / (W * ratio), unit: "imperial" });
                }
                // Metric / ratio: 1:100
                const ratioRe = /\b1\s*:\s*(\d{1,4})\b/g;
                while ((m = ratioRe.exec(text))) {
                  const n = parseInt(m[1], 10);
                  if (!n) continue;
                  const raw = `1:${n}`;
                  if (seen.has(raw)) continue;
                  seen.add(raw);
                  chips.push({ id: `p${page}-${chips.length}`, raw, scale: 864 / (W * n), unit: "metric" });
                }
                setPageScaleChips((prev) => ({ ...prev, [page]: chips }));
                if (chips.length > 0) {
                  setActiveChipId((prev) => prev[page] ? prev : { ...prev, [page]: chips[0].id });
                }
                // Detect sheet type (plan vs elevation)
                const sheetType = detectSheetType(text);
                setPageSheetType((prev) => ({ ...prev, [page]: sheetType }));
                // Detect roof pitch notation (e.g. "4:12", "6/12")
                const pitch = detectPitch(text);
                if (pitch) setPageRoofPitch((prev) => ({ ...prev, [page]: pitch }));
              }
            } catch { /* non-critical */ }
          })();
        }

        await task.promise;
      } catch (err: unknown) {
        if (err && typeof err === "object" && "name" in err && (err as { name: string }).name === "RenderingCancelledException") return;
      }
    })();
    return () => { cancelled = true; };
  }, [pdfDoc, page]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Z / X — independent zoom windows — intercepted before the input guard
      // so they work while the length box is focused. preventDefault stops typing.
      if (!e.ctrlKey && !e.metaKey && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "x")) {
        e.preventDefault();
        const key = e.key.toLowerCase() as 'z' | 'x';
        const boxRef = key === 'z' ? zoomBoxZRef : zoomBoxXRef;
        if (e.shiftKey) {
          // Shift+key — always draw a new box for this key
          setZoomDrawTarget(key); setZoomDrawing(true); setZoomDrawStart(null);
        } else if (activeZoomRef.current === key) {
          // Currently showing this key's zoom → go full screen
          setActiveZoom(null);
        } else if (boxRef.current) {
          // Box exists → switch to it
          setActiveZoom(key);
        } else {
          // No box yet → draw one
          setZoomDrawTarget(key); setZoomDrawing(true); setZoomDrawStart(null);
        }
        return;
      }

      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault(); e.shiftKey ? redo() : undo(); return;
      }
      if (e.key === "Escape") {
        // Cancel / discard whatever is in progress — nothing is committed
        setLineAnchor(null); setAreaPoints([]); setScaleModeStep(0); setScaleAnchor(null);
        setLockedAngle(null); setCustomAngleLock(null);
        setZoomDrawing(false); setZoomDrawStart(null); setZoomCorner1(null); // cancel drawing; keep existing zoom box
        if (tool === "setscale") setTool("dimension");
        return;
      }
      // L / R — lock current line direction exactly and focus length input.
      // Only intercepts when the line/dimension tool is active AND an anchor is set.
      // Otherwise falls through to the tool-shortcut handler so L switches to Line tool.
      if (!e.ctrlKey && !e.metaKey && (e.key.toLowerCase() === "l" || e.key.toLowerCase() === "r")) {
        const t = toolRef.current;
        if ((t === "line" || t === "dimension") && lineAnchorRef.current) {
          e.preventDefault();
          // Determine axis to lock:
          // • Mouse on canvas → snap cursor direction to nearest 45° (freshest signal,
          //   never inherits stale Shift state from a previous segment).
          // • Mouse off canvas + Shift actively held → use the visually-snapped angle.
          // • Mouse off canvas, no Shift → R = horizontal (0°), L = vertical (90°).
          let angle: number;
          if (mousePosRef.current) {
            const { x: ax, y: ay } = lineAnchorRef.current;
            const { x: mx, y: my } = mousePosRef.current;
            angle = Math.round(Math.atan2(my - ay, mx - ax) / (Math.PI / 4)) * (Math.PI / 4);
          } else if (lockedAngleRef.current !== null && shiftHeldRef.current) {
            angle = lockedAngleRef.current;
          } else {
            // No mouse context — R = horizontal, L = vertical
            angle = e.key.toLowerCase() === "r" ? 0 : Math.PI / 2;
          }
          customAngleLockRef.current = angle;
          setCustomAngleLock(angle);
          setTimeout(() => { ftInputRef.current?.select(); ftInputRef.current?.focus(); }, 0);
          return; // consumed — don't fall through to tool switcher
        }
        // Not in line-draw mode — fall through so L activates the Line tool shortcut
      }

      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        // Finish an in-progress line or dimension at the current cursor position
        if ((tool === "line" || tool === "dimension") && lineAnchor && mousePos) {
          const cal = customAngleLockRef.current;
          const b = lineEffectiveExistingRef.current
            ?? (cal !== null ? applyShiftSnap(lineAnchor, mousePos, true, Math.PI / 4, cal) : null)
            ?? applyShiftSnap(lineAnchor, mousePos, snap45, snapStep, lockedAngle);
          if (tool === "line") {
            pushHistory([...markup, { id: makeId(), page, kind: "line", a: lineAnchor, b, color, width: thickness, opacity: 1 }]);
          } else {
            const label = measureDistance(lineAnchor, b, pageAspect, scale);
            pushHistory([...markup, { id: makeId(), page, kind: "dimension", a: lineAnchor, b, label, color, width: 2, opacity: 1 }]);
          }
          setLineAnchor(null); setLockedAngle(null); setCustomAngleLock(null); // stop — don't chain
          return;
        }
        // Close an in-progress area polygon (needs ≥ 3 points)
        if (tool === "area" && areaPoints.length >= 3) {
          if (scale) {
            setPendingPoly([...areaPoints]);
            setPickerSheetType(pageSheetType[page] ?? "plan");
            setShowCatPicker(true);
            setAreaPoints([]);
          } else {
            pushHistory([...markup, { id: makeId(), page, kind: "area", polygon: [...areaPoints], sqFt: 0, category: "other", categoryColor: "#173a59", label: "Area", color: "#173a59", width: 2, opacity: 1 }]);
            setAreaPoints([]);
            setToast("Area added. Set scale to measure square footage.");
          }
          return;
        }
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) { removeSelected(); return; }
      const match = toolMeta.find((t) => t.shortcut.toLowerCase() === e.key.toLowerCase());
      if (match) switchTool(match.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(""), 3400);
    return () => window.clearTimeout(t);
  }, [toast]);

  // ── Loupe (magnifier) draw ───────────────────────────────────────────────────
  useEffect(() => {
    if (!loupeStage || !mousePos || !pdfCanvasRef.current || !loupeCanvasRef.current || !stagePx) return;
    const src = pdfCanvasRef.current;
    const dst = loupeCanvasRef.current;
    const LOUPE_CSS = loupeStage === 2 ? 464 : 220;
    const ZOOM      = loupeStage === 2 ? 4.5 : 3.5;
    const dpr = window.devicePixelRatio || 1;
    const dstPx = LOUPE_CSS * dpr;
    if (dst.width !== dstPx)  dst.width  = dstPx;
    if (dst.height !== dstPx) dst.height = dstPx;
    const ctx = dst.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, dstPx, dstPx);
    // Source region: how many stage CSS px to zoom into
    const physRatio = src.width / stagePx.w;      // physical px per stage CSS px
    const srcCSS    = LOUPE_CSS / ZOOM;            // stage CSS region being magnified
    const srcPx     = srcCSS * physRatio;          // same region in source physical px
    const cx = mousePos.x / 1000 * stagePx.w;     // cursor in stage CSS px
    const cy = mousePos.y / 1000 * stagePx.h;
    const sx = cx * physRatio - srcPx / 2;
    const sy = cy * physRatio - srcPx / 2;
    ctx.drawImage(src, sx, sy, srcPx, srcPx, 0, 0, dstPx, dstPx);
    // Crosshair at centre
    ctx.strokeStyle = "rgba(180,83,9,0.6)";
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.moveTo(dstPx / 2, dstPx / 2 - 10 * dpr); ctx.lineTo(dstPx / 2, dstPx / 2 + 10 * dpr); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(dstPx / 2 - 10 * dpr, dstPx / 2); ctx.lineTo(dstPx / 2 + 10 * dpr, dstPx / 2); ctx.stroke();
  }, [loupeStage, mousePos, stagePx]); // only re-run when these actually change

  // ── Memoized completed-markup SVG elements ──────────────────────────────────
  // Recalculated only when markup, selection, or drag changes — not on every
  // pointer-move render. This is the biggest source of unnecessary SVG work.
  const completedMarkupSvg = useMemo(() => pageMarkup.map((m) => {
    const isSel = selectedId === m.id;
    const selTx = isSel && dragOffset ? `translate(${dragOffset.x},${dragOffset.y})` : undefined;
    const cls = isSel ? "selected-markup" : "";

    if (m.kind === "path") return (
      <g key={m.id} transform={selTx} className={cls}>
        <polyline points={(m.points ?? []).map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={m.color} strokeWidth={m.width} strokeLinecap="round" strokeLinejoin="round" opacity={m.opacity} />
      </g>
    );
    if (m.kind === "line" && m.a && m.b) return (
      <g key={m.id} transform={selTx} className={cls}>
        <line x1={m.a.x} y1={m.a.y} x2={m.b.x} y2={m.b.y} stroke={m.color} strokeWidth={m.width} strokeLinecap="round" />
        <rect x={m.a.x - NODE_RADIUS} y={m.a.y - NODE_RADIUS} width={NODE_SIZE} height={NODE_SIZE} fill={m.color} />
        <rect x={m.b.x - NODE_RADIUS} y={m.b.y - NODE_RADIUS} width={NODE_SIZE} height={NODE_SIZE} fill={m.color} />
      </g>
    );
    if (m.kind === "dimension" && m.a && m.b) {
      const a = m.a, b = m.b;
      const ddx = b.x-a.x, ddy = b.y-a.y;
      const len = Math.hypot(ddx,ddy)||1;
      const px = -ddy/len, py = ddx/len;
      const tick = 12;
      const mx2 = (a.x+b.x)/2, my2 = (a.y+b.y)/2;
      let ang = Math.atan2(ddy,ddx)*180/Math.PI;
      if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
      const labelLen = (m.label?.length ?? 5) * 8 + 16;
      return (
        <g key={m.id} transform={selTx} stroke={m.color} strokeWidth={2} fill="none" className={cls}>
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
          <line x1={a.x-px*tick} y1={a.y-py*tick} x2={a.x+px*tick} y2={a.y+py*tick} />
          <line x1={b.x-px*tick} y1={b.y-py*tick} x2={b.x+px*tick} y2={b.y+py*tick} />
          <g transform={`translate(${mx2},${my2}) rotate(${ang})`}>
            <rect x={-labelLen/2} y={-14} width={labelLen} height={20} fill="white" strokeWidth={1.5} rx={3} />
            <text x={0} y={2} textAnchor="middle" dominantBaseline="middle" fill={m.color} fontSize={14} fontFamily="DM Sans,sans-serif" fontWeight={700} stroke="none">{m.label}</text>
          </g>
        </g>
      );
    }
    if (m.kind === "area" && m.polygon && m.polygon.length >= 3) {
      const pts = m.polygon;
      const cx2 = pts.reduce((s,p)=>s+p.x,0)/pts.length;
      const cy2 = pts.reduce((s,p)=>s+p.y,0)/pts.length;
      const cat = allAreaCategories.find((c)=>c.id===m.category);
      const clr = cat?.color || m.color;
      const labelText = m.label ?? "";
      const catLabel = cat?.label ?? "Area";
      return (
        <g key={m.id} transform={selTx} className={cls}>
          <polygon points={pts.map((p)=>`${p.x},${p.y}`).join(" ")} fill={clr} fillOpacity={0.15} stroke={clr} strokeWidth={2} strokeLinejoin="round" />
          <g>
            <rect x={cx2-52} y={cy2-26} width={104} height={38} fill="white" stroke={clr} strokeWidth={1.5} rx={4} />
            <text x={cx2} y={cy2-12} textAnchor="middle" fill={clr} fontSize={11} fontFamily="DM Sans,sans-serif" fontWeight={700}>{catLabel}</text>
            <text x={cx2} y={cy2+6} textAnchor="middle" fill={clr} fontSize={13} fontFamily="monospace" fontWeight={600}>{labelText}</text>
          </g>
        </g>
      );
    }
    if (m.kind === "text" && m.x !== undefined && m.y !== undefined) return (
      <g key={m.id} transform={selTx} className={cls}>
        <text x={m.x} y={m.y} fill={m.color} fontSize={18} fontFamily="DM Sans,sans-serif" fontWeight={600}>{m.text}</text>
      </g>
    );
    return null;
  }), [pageMarkup, selectedId, dragOffset]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Switch tool — cancel any in-progress drawing ───────────────────────────
  function switchTool(next: Tool) {
    setTool(next); setLineAnchor(null); setAreaPoints([]); setSelectedId(null);
  }

  // ── History ─────────────────────────────────────────────────────────────────
  function pushHistory(next: Markup[]) { setHistory((h) => [...h, markup]); setFuture([]); setMarkup(next); }
  function undo() { const p = history.at(-1); if (!p) return; setFuture((f) => [markup, ...f]); setMarkup(p); setHistory((h) => h.slice(0, -1)); setSelectedId(null); }
  function redo() { const n = future[0]; if (!n) return; setHistory((h) => [...h, markup]); setMarkup(n); setFuture((f) => f.slice(1)); }

  // ── File loading ─────────────────────────────────────────────────────────────
  async function readFile(file?: File) {
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("Not a PDF — choose a plan PDF to get started."); return;
    }
    setError(""); setIsLoading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pdfjsLib = await getPdfjs();
      const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      setPdfDoc(doc); setPdfBytes(bytes); setFileName(file.name); setFileSize(file.size);
      setPageCount(doc.numPages); setMarkup([]); setHistory([]); setFuture([]);
      setPage(1); setSelectedId(null); setLineAnchor(null); setAreaPoints([]);
      setPageScaleChips({}); setActiveChipId({}); setPageWidthPt({}); setPageSheetType({}); setPageRoofPitch({});
      setToast(`${file.name} opened — ${doc.numPages} ${doc.numPages === 1 ? "page" : "pages"}.`);
    } catch { setError("The PDF could not be read. Try again."); }
    finally { setIsLoading(false); }
  }
  function onFileChange(e: ChangeEvent<HTMLInputElement>) { void readFile(e.target.files?.[0]); e.target.value = ""; }

  // ── Trigger opening scan when schedule opens ──────────────────────────────
  useEffect(() => {
    if (showSchedule && pdfDoc && !scannedSchedule) void scanForOpenings();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSchedule]);

  // ── Zoom-viewport: wheel-to-zoom (non-passive, so we can preventDefault) ────
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!activeZoomRef.current) return;   // full-canvas: ignore
      if (!e.altKey) return;               // only act when Alt is held
      e.preventDefault();
      const box = activeZoomRef.current === 'z' ? zoomBoxZRef.current : zoomBoxXRef.current;
      if (!box) return;
      const r  = el.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top)  / r.height;
      // Cursor in SVG-space coords
      const bw = Math.max(box.x2 - box.x1, 10);
      const bh = Math.max(box.y2 - box.y1, 10);
      const s  = Math.min(1000 / bw, 1000 / bh);
      const tx = 0.5 - ((box.x1 + box.x2) / 2000) * s;
      const ty = 0.5 - ((box.y1 + box.y2) / 2000) * s;
      const svgX = (fx - tx) / s * 1000;
      const svgY = (fy - ty) / s * 1000;
      // Scroll down = zoom out (box grows), scroll up = zoom in (box shrinks)
      const factor = e.deltaY > 0 ? 1.13 : 0.88;
      const nb = {
        x1: Math.max(0,    svgX + (box.x1 - svgX) * factor),
        y1: Math.max(0,    svgY + (box.y1 - svgY) * factor),
        x2: Math.min(1000, svgX + (box.x2 - svgX) * factor),
        y2: Math.min(1000, svgY + (box.y2 - svgY) * factor),
      };
      if (activeZoomRef.current === 'z') setZoomBoxZ(nb); else setZoomBoxX(nb);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []); // stable: all reads go through refs

  // ── Session save / load (.mk) ────────────────────────────────────────────────
  async function saveSession() {
    if (!pdfBytes || !fileName) return;
    // Convert PDF bytes to base64
    let binary = "";
    const chunk = 8192;
    for (let i = 0; i < pdfBytes.length; i += chunk) {
      binary += String.fromCharCode(...pdfBytes.subarray(i, i + chunk));
    }
    const pdfBase64 = btoa(binary);
    const session = {
      version: 1,
      fileName,
      pdfBase64,
      markup,
      activeChipId,
      pageScaleChips,
      scheduleNotes,
    };
    const blob = new Blob([JSON.stringify(session)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileName.replace(/\.pdf$/i, "") + ".mk";
    link.click();
    URL.revokeObjectURL(link.href);
    setToast("Session saved — reopen the .mk file to resume.");
  }

  async function loadSession(file: File) {
    setError(""); setIsLoading(true);
    try {
      const text = await file.text();
      const session = JSON.parse(text) as {
        version: number; fileName: string; pdfBase64: string;
        markup: Markup[]; activeChipId: Record<number, string>;
        pageScaleChips: Record<number, ScaleChip[]>;
        scheduleNotes?: string;
      };
      if (!session.pdfBase64 || !session.markup) throw new Error("Invalid session file.");
      // Decode base64 → Uint8Array
      const binary = atob(session.pdfBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const pdfjsLib = await getPdfjs();
      const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      setPdfDoc(doc); setPdfBytes(bytes);
      setFileName(session.fileName); setFileSize(bytes.length);
      setPageCount(doc.numPages);
      setMarkup(session.markup);
      setHistory([]); setFuture([]);
      setPage(1); setSelectedId(null); setLineAnchor(null); setAreaPoints([]);
      setActiveChipId(session.activeChipId ?? {});
      setPageScaleChips(session.pageScaleChips ?? {});
      setPageWidthPt({}); setPageSheetType({}); setPageRoofPitch({}); setPageTextItems({});
      setScheduleNotes(session.scheduleNotes ?? "");
      setScannedSchedule(null);
      setToast(`Session restored — ${doc.numPages} ${doc.numPages === 1 ? "page" : "pages"}, ${session.markup.length} markup items.`);
    } catch { setError("Could not load session file. Make sure it's a .mk file from this app."); }
    finally { setIsLoading(false); }
  }

  // ── Scan PDF for doors / windows / garage doors ───────────────────────────
  async function scanForOpenings() {
    if (!pdfDoc) return;
    setScannedSchedule({ doors: [], windows: [], garageDoors: [], scanning: true });
    const doors = new Map<string, number>();
    const windows = new Map<string, number>();
    const garageDoors = new Map<string, number>();

    const pagePromises: Promise<void>[] = [];
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      pagePromises.push(
        pdfDoc.getPage(p).then((pg) => pg.getTextContent()).then((content) => {
          const items = content.items as Array<{ str: string }>;
          for (const it of items) {
            const s = it.str.trim();
            if (!s) continue;
            // Skip strings that already contain foot/inch marks (dimension labels)
            if (/['\u2019"\u201d]/.test(s)) continue;
            // WxH — windows and garage doors
            const winMatch = s.match(/^(\d{1,3})\s*[xX×]\s*(\d{1,3})$/);
            if (winMatch) {
              const w = parseInt(winMatch[1], 10), h = parseInt(winMatch[2], 10);
              const key = `${winMatch[1]}×${winMatch[2]}`;
              if (w <= 20 && h <= 20) garageDoors.set(key, (garageDoors.get(key) ?? 0) + 1);
              else windows.set(key, (windows.get(key) ?? 0) + 1);
              continue;
            }
            // Bare 2-3 digit door width in inches (18–96)
            const doorMatch = s.match(/^(\d{2,3})$/);
            if (doorMatch) {
              const val = parseInt(s, 10);
              if (val >= 18 && val <= 96) {
                const ft = Math.floor(val / 12), inch = val % 12;
                const key = `${ft}'-${inch}"`;
                doors.set(key, (doors.get(key) ?? 0) + 1);
              }
            }
          }
        })
      );
    }
    await Promise.all(pagePromises);

    const toList = (m: Map<string, number>) =>
      Array.from(m.entries())
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => a.key.localeCompare(b.key));

    setScannedSchedule({ doors: toList(doors), windows: toList(windows), garageDoors: toList(garageDoors), scanning: false });
  }

  // ── Box zoom helpers ─────────────────────────────────────────────────────────
  function computeZoomTransform(box: { x1: number; y1: number; x2: number; y2: number }): string {
    const bw = Math.max(box.x2 - box.x1, 10);
    const bh = Math.max(box.y2 - box.y1, 10);
    const s  = Math.min(1000 / bw, 1000 / bh);
    const cx = (box.x1 + box.x2) / 2000; // box centre as fraction of stage
    const cy = (box.y1 + box.y2) / 2000;
    const tx = (0.5 - cx * s) * 100;     // translate % (origin 0,0)
    const ty = (0.5 - cy * s) * 100;
    return `translate(${tx.toFixed(3)}%, ${ty.toFixed(3)}%) scale(${s.toFixed(4)})`;
  }

  // ── Pointer helpers ──────────────────────────────────────────────────────────
  function getPoint(e: ReactPointerEvent<HTMLDivElement>): Pt {
    const r = stageRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    let x = ((e.clientX - r.left) / r.width)  * 1000;
    let y = ((e.clientY - r.top)  / r.height) * 1000;
    // When a zoom is active, invert its CSS transform to recover true SVG coordinates
    const activeBox = activeZoom === 'z' ? zoomBoxZ : activeZoom === 'x' ? zoomBoxX : null;
    if (activeBox) {
      const zoomBox = activeBox;
      const bw = Math.max(zoomBox.x2 - zoomBox.x1, 10);
      const bh = Math.max(zoomBox.y2 - zoomBox.y1, 10);
      const s  = Math.min(1000 / bw, 1000 / bh);
      const cx = (zoomBox.x1 + zoomBox.x2) / 2000;
      const cy = (zoomBox.y1 + zoomBox.y2) / 2000;
      const tx = 0.5 - cx * s; // same fractions as computeZoomTransform
      const ty = 0.5 - cy * s;
      x = (x / 1000 - tx) / s * 1000;
      y = (y / 1000 - ty) / s * 1000;
    }
    return {
      x: Math.max(0, Math.min(1000, x)),
      y: Math.max(0, Math.min(1000, y)),
    };
  }

  // ── Scale calibration pointer ──────────────────────────────────────────────
  function handleScaleModeClick(pt: Pt) {
    if (scaleModeStep === 0) {
      setScaleAnchor(pt); setScaleModeStep(1); setToast("Now click the second point.");
    } else if (scaleModeStep === 1) {
      setScaleEnd(pt); setScaleModeStep(2);
    }
  }

  function commitScale() {
    if (!scaleAnchor || !scaleEnd) return;
    const ft = parseFloat(scaleFt) || 0;
    const inches = parseFloat(scaleIn) || 0;
    const totalFt = ft + inches / 12;
    if (totalFt <= 0) { setToast("Enter a length greater than zero."); return; }
    const nd = normDist(scaleAnchor, scaleEnd, pageAspect);
    const newScale = nd / totalFt;
    // Add as a chip for this page (replaces any previous manual chip)
    const chip: ScaleChip = {
      id: `p${page}-manual`,
      raw: `${formatFtIn(totalFt)} ref`,
      scale: newScale,
      unit: "imperial",
    };
    setPageScaleChips((prev) => {
      const existing = (prev[page] ?? []).filter((c) => c.id !== chip.id);
      return { ...prev, [page]: [...existing, chip] };
    });
    setActiveChipId((prev) => ({ ...prev, [page]: chip.id }));
    setScaleModeStep(0); setScaleAnchor(null); setScaleEnd(null); setScaleFt(""); setScaleIn("");
    setTool("dimension");
    setToast(`Scale set — ${formatFtIn(totalFt)} reference length.`);
  }

  // ── Stage pointer events ─────────────────────────────────────────────────────
  function pointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    // Zoom box drawing — drag OR two-click
    if (zoomDrawing) {
      const pt = getPoint(e);
      if (zoomCorner1) {
        // Second click → commit box immediately from corner1 to here
        const x1 = Math.min(zoomCorner1.x, pt.x), x2 = Math.max(zoomCorner1.x, pt.x);
        const y1 = Math.min(zoomCorner1.y, pt.y), y2 = Math.max(zoomCorner1.y, pt.y);
        if (x2 - x1 > 8 && y2 - y1 > 8) {
          const box = { x1, y1, x2, y2 };
          if (zoomDrawTarget === 'z') setZoomBoxZ(box); else setZoomBoxX(box);
          setActiveZoom(zoomDrawTarget);
        }
        setZoomDrawing(false); setZoomDrawStart(null); setZoomCorner1(null);
      } else {
        setZoomDrawStart(pt);
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      return;
    }

    const rawPt = getPoint(e);
    // Apply existing-point snap on click (existing endpoint takes priority)
    const raw = (tool === "line" || tool === "dimension" || tool === "area") ? snapExisting(rawPt) : rawPt;

    // Scale calibration
    if (tool === "setscale") { handleScaleModeClick(raw); return; }

    // Line tool
    if (tool === "line") {
      if (!lineAnchor) { setLineAnchor(raw); return; }
      const b = lineEffectiveExisting ?? lineProjected?.snapped ?? currentSnap(raw, lineAnchor);
      pushHistory([...markup, { id: makeId(), page, kind: "line", a: lineAnchor, b, color, width: thickness, opacity: 1 }]);
      setLineAnchor(b); // chain lines
      return;
    }

    // Dimension tool
    if (tool === "dimension") {
      if (!lineAnchor) { setLineAnchor(raw); return; }
      const b = lineEffectiveExisting ?? lineProjected?.snapped ?? currentSnap(raw, lineAnchor);
      const label = measureDistance(lineAnchor, b, pageAspect, scale);
      pushHistory([...markup, { id: makeId(), page, kind: "dimension", a: lineAnchor, b, label, color, width: 2, opacity: 1 }]);
      setLineAnchor(null);
      return;
    }

    // Area tool
    if (tool === "area") {
      const pt = areaEffectiveExisting ?? areaProjected?.snapped ?? (areaPoints.length > 0 ? currentSnap(raw, areaPoints[areaPoints.length - 1]) : raw);
      const closeThreshold = 3;
      if (areaPoints.length >= 3 && Math.hypot(pt.x - areaPoints[0].x, pt.y - areaPoints[0].y) < closeThreshold) {
        // Close the polygon
        if (scale) {
          setPendingPoly([...areaPoints]);
          setPickerSheetType(pageSheetType[page] ?? "plan");
          setShowCatPicker(true);
          setAreaPoints([]);
        } else {
          // No scale — save area without measurements
          const sqFt = 0;
          pushHistory([...markup, { id: makeId(), page, kind: "area", polygon: [...areaPoints], sqFt, category: "other", categoryColor: "#173a59", label: "Area", color: "#173a59", width: 2, opacity: 1 }]);
          setAreaPoints([]);
          setToast("Area added. Set scale to measure square footage.");
        }
        return;
      }
      setAreaPoints((pts) => [...pts, pt]);
      return;
    }

    // Select
    if (tool === "select") {
      const hit = [...pageMarkup].reverse().find((m) => {
        if (m.kind === "path") {
          const pts = m.points ?? [];
          for (let i = 0; i < pts.length - 1; i++)
            if (distToSegment(raw, pts[i], pts[i + 1]) < 18) return true;
          return false;
        }
        if (m.kind === "line" || m.kind === "dimension")
          return !!(m.a && m.b && distToSegment(raw, m.a, m.b) < 20);
        if (m.kind === "area" && m.polygon && m.polygon.length >= 3) {
          if (pointInPolygon(raw, m.polygon)) return true;
          for (let i = 0; i < m.polygon.length; i++)
            if (distToSegment(raw, m.polygon[i], m.polygon[(i + 1) % m.polygon.length]) < 15) return true;
          return false;
        }
        if (m.kind === "text" && m.x !== undefined && m.y !== undefined)
          return Math.hypot(raw.x - m.x, raw.y - m.y) < 40;
        return false;
      });
      setSelectedId(hit?.id ?? null);
      dragAnchorRef.current = hit ? raw : null;
      setDragOffset(null);
      return;
    }

    // Text
    if (tool === "text") {
      const text = window.prompt("Add a note:");
      if (text?.trim()) pushHistory([...markup, { id: makeId(), page, kind: "text", text: text.trim(), x: raw.x, y: raw.y, color, width: thickness, opacity: 1 }]);
      return;
    }

    // Eraser
    if (tool === "eraser") {
      const hit = pageMarkup.find((m) => m.kind === "path" && m.points?.some((p) => Math.hypot(p.x - raw.x, p.y - raw.y) < 34));
      if (hit) { pushHistory(markup.filter((m) => m.id !== hit.id)); setToast("Markup erased."); }
      return;
    }

    // Pen / highlight — start stroke
    drawingRef.current = {
      id: makeId(), page, kind: "path", points: [raw], color,
      width:   tool === "highlight" ? Math.max(14, thickness * 3) : thickness,
      opacity: tool === "highlight" ? 0.28 : 1,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function pointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const pt = getPoint(e);
    setMousePos(pt);

    // Select-mode drag — compute live offset from anchor
    if (tool === "select" && dragAnchorRef.current && selectedIdRef.current) {
      const dx = pt.x - dragAnchorRef.current.x;
      const dy = pt.y - dragAnchorRef.current.y;
      if (Math.hypot(dx, dy) > 4) setDragOffset({ x: dx, y: dy });
      return;
    }

    if (!drawingRef.current) return;
    const d = drawingRef.current;
    d.points?.push(pt);
    setMarkup((prev) => [...prev.filter((m) => m.id !== d.id), { ...d, points: [...(d.points ?? [])] }]);
  }

  function pointerUp() {
    // Commit select-mode drag
    if (dragOffset && selectedIdRef.current) {
      const { x: dx, y: dy } = dragOffset;
      const id = selectedIdRef.current;
      const tr = (p: Pt): Pt => ({ x: p.x + dx, y: p.y + dy });
      const updated = markup.map((m): Markup => {
        if (m.id !== id) return m;
        if (m.kind === "path")      return { ...m, points: m.points?.map(tr) };
        if (m.kind === "line" || m.kind === "dimension")
                                    return { ...m, a: tr(m.a!), b: tr(m.b!) };
        if (m.kind === "area")      return { ...m, polygon: m.polygon?.map(tr) };
        if (m.kind === "text")      return { ...m, x: (m.x ?? 0) + dx, y: (m.y ?? 0) + dy };
        return m;
      });
      pushHistory(updated);
      dragAnchorRef.current = null;
      setDragOffset(null);
      return;
    }
    dragAnchorRef.current = null;

    // Complete zoom box drawing
    if (zoomDrawing && zoomDrawStart && mousePos) {
      const dx = Math.abs(mousePos.x - zoomDrawStart.x);
      const dy = Math.abs(mousePos.y - zoomDrawStart.y);
      const DRAG_THRESHOLD = 10; // SVG units — below this, treat as a first-corner click
      if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) {
        // Small drag = first-corner click — enter two-click mode
        setZoomCorner1(zoomDrawStart);
        setZoomDrawStart(null);
        return;
      }
      // Large drag = commit box immediately
      const x1 = Math.min(zoomDrawStart.x, mousePos.x);
      const x2 = Math.max(zoomDrawStart.x, mousePos.x);
      const y1 = Math.min(zoomDrawStart.y, mousePos.y);
      const y2 = Math.max(zoomDrawStart.y, mousePos.y);
      if (x2 - x1 > 8 && y2 - y1 > 8) {
        const box = { x1, y1, x2, y2 };
        if (zoomDrawTarget === 'z') setZoomBoxZ(box);
        else                        setZoomBoxX(box);
        setActiveZoom(zoomDrawTarget);
      }
      setZoomDrawing(false); setZoomDrawStart(null); setZoomCorner1(null);
      return;
    }
    if (!drawingRef.current) return;
    const finished = drawingRef.current; drawingRef.current = null;
    const rest = markup.filter((m) => m.id !== finished.id);
    if ((finished.points?.length ?? 0) > 1) { setHistory((h) => [...h, rest]); setFuture([]); setMarkup([...rest, finished]); }
    else setMarkup(rest);
  }

  // ── Dimension bar: commit typed length ───────────────────────────────────────
  function handleDimEnter() {
    // When direction-locked, mouse may be off the canvas (liveTarget null while typing).
    // Synthesise a unit target from the locked angle so the guard below always passes.
    const effectiveTarget: Pt | null = liveTarget
      ?? (customAngleLock !== null && liveAnchor
          ? { x: liveAnchor.x + Math.cos(customAngleLock),
              y: liveAnchor.y + Math.sin(customAngleLock) }
          : null);
    if (!liveAnchor || !effectiveTarget || !scale) return;
    const ft  = parseFloat(dimFt) || 0;
    const ins = parseInchStr(dimIn);
    const totalFeet = ft + ins / 12;
    if (totalFeet <= 0) return;
    const normD_current = normDist(liveAnchor, effectiveTarget, pageAspect);
    if (normD_current === 0) return;
    const factor = (totalFeet * scale) / normD_current;
    const endpoint: Pt = {
      x: liveAnchor.x + (effectiveTarget.x - liveAnchor.x) * factor,
      y: liveAnchor.y + (effectiveTarget.y - liveAnchor.y) * factor,
    };
    if (tool === "line") {
      pushHistory([...markup, { id: makeId(), page, kind: "line", a: liveAnchor, b: endpoint, color, width: thickness, opacity: 1 }]);
      setLineAnchor(endpoint);
      // Release the direction lock so the cursor is free to aim at the next direction.
      setCustomAngleLock(null);
      customAngleLockRef.current = null;
      // Blur the length input so the next L/R keypress reaches the window handler
      // (window handler exits early when an <input> is the event target).
      setTimeout(() => ftInputRef.current?.blur(), 0);
    } else if (tool === "dimension") {
      const label = measureDistance(liveAnchor, endpoint, pageAspect, scale);
      pushHistory([...markup, { id: makeId(), page, kind: "dimension", a: liveAnchor, b: endpoint, label, color, width: 2, opacity: 1 }]);
      setLineAnchor(null); setCustomAngleLock(null);
    } else if (tool === "area") {
      setAreaPoints((pts) => [...pts, endpoint]);
    }
    setDimEditing(false);
  }

  // ── Area category commit ─────────────────────────────────────────────────────
  function commitArea(catId: string) {
    if (!pendingPoly || !scale) return;
    if (catId === "roof") {
      const sqFt = polygonSqFt(pendingPoly, pageAspect, scale);
      setPendingSqFt(sqFt);
      setSelectedPitch(pageRoofPitch[page] ?? "6:12");
      setShowPitchPicker(true);
      return;
    }
    const cat = allAreaCategories.find((c) => c.id === catId) ?? allAreaCategories[5];
    const sqFt = polygonSqFt(pendingPoly, pageAspect, scale);
    const label = `${Math.round(sqFt)} sq ft`;
    const newArea: Markup = {
      id: editingAreaId ?? makeId(), page, kind: "area",
      polygon: pendingPoly, sqFt, category: cat.id,
      categoryColor: cat.color, label,
      color: cat.color, width: 2, opacity: 1,
    };
    if (editingAreaId) {
      pushHistory(markup.map((m) => m.id === editingAreaId ? newArea : m));
      setEditingAreaId(null);
    } else {
      pushHistory([...markup, newArea]);
    }
    setPendingPoly(null); setShowCatPicker(false);
    setToast(`${cat.label} — ${label}.`);
  }

  function commitRoofArea() {
    if (!pendingPoly || !scale) return;
    const cat = areaCategories.find((c) => c.id === "roof")!;
    const sqFt = pendingSqFt;
    const rise = ROOF_PITCHES.find((p) => p.label === selectedPitch)?.rise ?? 6;
    const adjustedSqFt = sqFt * slopeMultiplier(rise);
    const label = `${Math.round(sqFt)} ft² flat`;
    const newArea: Markup = {
      id: editingAreaId ?? makeId(), page, kind: "area",
      polygon: pendingPoly, sqFt, adjustedSqFt, slopePitch: selectedPitch,
      category: "roof", categoryColor: cat.color, label,
      color: cat.color, width: 2, opacity: 1,
    };
    if (editingAreaId) {
      pushHistory(markup.map((m) => m.id === editingAreaId ? newArea : m));
      setEditingAreaId(null);
    } else {
      pushHistory([...markup, newArea]);
    }
    setPendingPoly(null); setShowCatPicker(false); setShowPitchPicker(false);
    setToast(`Roof: ${Math.round(sqFt)} ft² flat → ${Math.round(adjustedSqFt)} ft² @ ${selectedPitch}`);
  }

  // ── Remove / clear ───────────────────────────────────────────────────────────
  function removeSelected() {
    if (!selectedId) return;
    pushHistory(markup.filter((m) => m.id !== selectedId));
    setSelectedId(null); setToast("Markup removed.");
  }
  function clearAll() {
    const onPage = markup.filter((m) => m.page === page);
    if (!onPage.length) return;
    if (!window.confirm(`Clear all markup from page ${page}?`)) return;
    pushHistory(markup.filter((m) => m.page !== page));
    setSelectedId(null); setToast("Page markup cleared.");
  }

  // ── Export ────────────────────────────────────────────────────────────────────
  async function exportDocument() {
    if (!pdfBytes) return;
    const base = fileName.replace(/\.pdf$/i, "");
    if (exportType === "vector") {
      try {
        const pdfLibDoc = await PDFDocument.load(pdfBytes);
        const pages = pdfLibDoc.getPages();
        const pagesToProcess = exportRange === "all" ? pages.map((_, i) => i + 1) : [page];
        for (const pn of pagesToProcess) {
          const pp = pages[pn - 1]; if (!pp) continue;
          const { width: pw, height: ph } = pp.getSize();
          for (const m of markup.filter((mk) => mk.page === pn)) {
            const toX = (nx: number) => (nx / 1000) * pw;
            const toY = (ny: number) => ph - (ny / 1000) * ph;
            const [r, g, b] = hexToRgb(m.color);
            if (m.kind === "path" && m.points && m.points.length >= 2) {
              for (let i = 1; i < m.points.length; i++) {
                pp.drawLine({ start: { x: toX(m.points[i-1].x), y: toY(m.points[i-1].y) }, end: { x: toX(m.points[i].x), y: toY(m.points[i].y) }, thickness: m.width * 0.5, color: rgb(r,g,b), opacity: m.opacity, lineCap: LineCapStyle.Round });
              }
            } else if ((m.kind === "line" || m.kind === "dimension") && m.a && m.b) {
              pp.drawLine({ start: { x: toX(m.a.x), y: toY(m.a.y) }, end: { x: toX(m.b.x), y: toY(m.b.y) }, thickness: 1.5, color: rgb(r,g,b), opacity: 1, lineCap: LineCapStyle.Round });
              if (m.kind === "dimension" && m.label) {
                pp.drawText(m.label, { x: toX((m.a.x+m.b.x)/2)-16, y: toY((m.a.y+m.b.y)/2), size: 10, color: rgb(r,g,b) });
              }
            } else if (m.kind === "area" && m.polygon && m.polygon.length >= 3 && m.label) {
              const cx = m.polygon.reduce((s,p) => s+p.x, 0)/m.polygon.length;
              const cy = m.polygon.reduce((s,p) => s+p.y, 0)/m.polygon.length;
              pp.drawText(m.label, { x: toX(cx)-16, y: toY(cy), size: 10, color: rgb(r,g,b) });
            } else if (m.kind === "text" && m.text && m.x !== undefined && m.y !== undefined) {
              pp.drawText(m.text, { x: toX(m.x), y: toY(m.y), size: 12, color: rgb(r,g,b) });
            }
          }
        }
        const outBytes = await pdfLibDoc.save();
        const link = window.document.createElement("a");
        link.href = URL.createObjectURL(new Blob([outBytes.buffer as ArrayBuffer], { type: "application/pdf" }));
        link.download = `${base}-marked-up.pdf`; link.click(); URL.revokeObjectURL(link.href);
        setToast("Marked-up PDF exported.");
      } catch { setToast("Export failed — try again."); }
    } else {
      if (!pdfDoc) return;
      const pdfPage = await pdfDoc.getPage(page);
      const dpiScale = dpi === "300" ? 4 : 2;
      const vp = pdfPage.getViewport({ scale: dpiScale });
      const off = window.document.createElement("canvas");
      off.width = vp.width; off.height = vp.height;
      const ctx = off.getContext("2d")!;
      await pdfPage.render({ canvasContext: ctx, viewport: vp, canvas: off }).promise;
      for (const m of pageMarkup) {
        if (m.kind === "path" && m.points && m.points.length >= 2) {
          ctx.save(); ctx.globalAlpha = m.opacity; ctx.strokeStyle = m.color;
          ctx.lineWidth = (m.width / 1000) * vp.width; ctx.lineCap = "round"; ctx.lineJoin = "round";
          ctx.beginPath();
          m.points.forEach((pt, i) => { const px=(pt.x/1000)*vp.width, py=(pt.y/1000)*vp.height; i===0?ctx.moveTo(px,py):ctx.lineTo(px,py); });
          ctx.stroke(); ctx.restore();
        }
      }
      off.toBlob((blob) => {
        if (!blob) return;
        const link = window.document.createElement("a");
        link.href = URL.createObjectURL(blob); link.download = `${base}-page-${page}.png`;
        link.click(); URL.revokeObjectURL(link.href);
        setToast(`Page ${page} exported as PNG.`);
      }, "image/png");
    }
    setShowExport(false);
  }

  // ── Computed snapped preview point ──────────────────────────────────────────
  // Hysteretic snap: engage within SNAP_EXISTING_PX, release only past 1.6× that radius.
  // Prevents the dim box from flickering when the cursor hovers at the snap boundary.
  const existingSnapPt: Pt | null = (() => {
    if (!mousePos) { snapHoldRef.current = null; return null; }
    const raw = nearestExisting(mousePos);
    if (raw) { snapHoldRef.current = raw; return raw; }
    if (snapHoldRef.current) {
      const d = Math.hypot(snapHoldRef.current.x - mousePos.x, snapHoldRef.current.y - mousePos.y);
      if (d < SNAP_EXISTING_PX * 1.6) return snapHoldRef.current; // hold snap while nearby
      snapHoldRef.current = null;
    }
    return null;
  })();
  const areaLastPt = areaPoints.length > 0 ? areaPoints[areaPoints.length - 1] : null;

  // When direction-locked, filter existing snap to only points ON the locked axis.
  // Off-axis existing points are ignored so the direction lock cannot be broken.
  const lineEffectiveExisting = (snap45 && lockedAngle !== null && lineAnchor)
    ? filterExistingToAxis(existingSnapPt, lineAnchor, lockedAngle)
    : existingSnapPt;
  const areaEffectiveExisting = (snap45 && lockedAngle !== null && areaLastPt)
    ? filterExistingToAxis(existingSnapPt, areaLastPt, lockedAngle)
    : existingSnapPt;

  // Projected snap — active when direction-locked, no on-axis existing snap found
  const lineProjected = (snap45 && lockedAngle !== null && lineAnchor && mousePos && !lineEffectiveExisting)
    ? nearestProjectedOnLocked(lineAnchor, lockedAngle, mousePos) : null;
  const areaProjected = (snap45 && lockedAngle !== null && areaLastPt && mousePos && !areaEffectiveExisting)
    ? nearestProjectedOnLocked(areaLastPt, lockedAngle, mousePos) : null;

  // Sync ref so keydown handler (stale closure) can read the latest value
  lineEffectiveExistingRef.current = lineEffectiveExisting;

  const previewPt = mousePos
    ? lineEffectiveExisting
      ?? lineProjected?.snapped
      ?? (customAngleLock !== null && lineAnchor
           ? applyShiftSnap(lineAnchor, mousePos, true, Math.PI / 4, customAngleLock)
           : lineAnchor ? applyShiftSnap(lineAnchor, mousePos, snap45, snapStep, lockedAngle) : mousePos)
    : null;
  const previewAreaPt = mousePos
    ? areaEffectiveExisting
      ?? areaProjected?.snapped
      ?? (areaLastPt ? applyShiftSnap(areaLastPt, mousePos, snap45, snapStep, lockedAngle) : mousePos)
    : null;
  // Active anchor + target for the dim bar
  const liveAnchor: Pt | null = (tool === "line" || tool === "dimension") ? lineAnchor
    : (tool === "area" && areaPoints.length > 0) ? areaPoints[areaPoints.length - 1] : null;
  const liveTarget: Pt | null = (tool === "line" || tool === "dimension") ? previewPt
    : (tool === "area") ? previewAreaPt : null;
  liveTargetRef.current = liveTarget; // keep ref in sync for the dim effect
  const scalePreviewPt = mousePos && scaleAnchor ? mousePos : null;

  // ── Schedule data ─────────────────────────────────────────────────────────────
  const scheduleAreas = markup.filter((m) => m.kind === "area");
  const makeCatRows = (cats: typeof areaCategories) => cats.map((cat) => {
    const areas = scheduleAreas.filter((m) => m.category === cat.id);
    // For roof, total by adjusted sq ft (actual material); others by plan sq ft
    const total = areas.reduce((s, m) => s + (m.category === "roof" ? (m.adjustedSqFt ?? m.sqFt ?? 0) : (m.sqFt ?? 0)), 0);
    return { ...cat, areas, total };
  }).filter((c) => c.areas.length > 0);
  const schedulePlan      = makeCatRows(areaCategories);
  const scheduleElevation = makeCatRows(elevationCategories);
  const grandTotal = scheduleAreas.reduce((s, m) => s + (m.category === "roof" ? (m.adjustedSqFt ?? m.sqFt ?? 0) : (m.sqFt ?? 0)), 0);

  const pageNums = Array.from({ length: pageCount }, (_, i) => i + 1);
  const hasPdf = !!pdfDoc;

  // ── Cursor class ─────────────────────────────────────────────────────────────
  const cursorClass = zoomDrawing ? "cursor-crosshair"
    : tool === "setscale" || tool === "dimension" || tool === "line" || tool === "area"
    ? "cursor-crosshair" : tool === "eraser" ? "cursor-cell" : tool === "pen" || tool === "highlight" ? "cursor-crosshair" : "cursor-default";

  return (
    <main className="h-[100dvh] overflow-hidden bg-background text-foreground">
      {!hasPdf ? (
        <EmptyState fileInputRef={fileInputRef} isLoading={isLoading} error={error} onFileChange={onFileChange} onOpen={() => fileInputRef.current?.click()} />
      ) : (
        <div className="flex h-[100dvh] flex-col">

          {/* ── Header ── */}
          <header className="flex h-[72px] shrink-0 items-center justify-between border-b border-sidebar-border bg-sidebar px-4 text-sidebar-foreground md:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground"><Ruler size={19} strokeWidth={2.5} /></div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold tracking-tight">PDF Markup Studio</span>
                  <span className="hidden rounded-full border border-sidebar-border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-sidebar-accent-foreground sm:inline">Local workspace</span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-sidebar-foreground/65"><FileText size={12} /><span className="truncate">{fileName}</span><span>·</span><span>{formatSize(fileSize)}</span></div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button className="icon-button-dark hidden sm:inline-flex" onClick={() => setShowSchedule(true)} aria-label="Construction schedule"><ClipboardList size={17} /></button>
              <button className="icon-button-dark hidden sm:inline-flex" onClick={() => sessionInputRef.current?.click()} aria-label="Load session" title="Load session (.mk)"><FolderOpen size={17} /></button>
              <button className="icon-button-dark hidden sm:inline-flex" onClick={() => void saveSession()} disabled={!pdfBytes} aria-label="Save session" title="Save session (.mk)"><Save size={17} /></button>
              <button
                className="hidden sm:flex flex-col items-center justify-center rounded-xl border border-sidebar-border bg-sidebar-primary/10 px-3 py-1 leading-none text-sidebar-foreground transition hover:bg-sidebar-primary/20 disabled:opacity-40"
                onClick={() => void saveSession()}
                disabled={!pdfBytes}
              >
                <span className="text-[10px] font-bold uppercase tracking-wider">Save Markup</span>
                <span className="text-[9px] text-sidebar-foreground/60">.mk file (editable)</span>
              </button>
              <button
                className="flex flex-col items-center justify-center rounded-xl bg-primary px-3 py-1 leading-none text-white shadow-sm transition hover:bg-primary/90"
                onClick={() => setShowExport(true)}
              >
                <span className="text-[10px] font-bold uppercase tracking-wider">Flatten To</span>
                <span className="text-[9px] text-white/70">.PDF / .PNG / .JPG</span>
              </button>
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col md:flex-row">

            {/* ── Tool panel ── */}
            <aside className={`${mobileTools ? "block" : "hidden"} border-b border-sidebar-border bg-sidebar md:block md:w-[220px] md:shrink-0 md:border-b-0 md:border-r`}>
              <div className="flex h-full flex-col p-4">
                {/* Scale indicator — top of sidebar */}
                {pdfDoc && (
                  <div className={`mb-3 flex flex-wrap items-center justify-between gap-1.5 rounded-lg px-3 py-2 text-[10px] ${scale ? "bg-emerald-500/10 text-emerald-700" : "bg-sidebar-border/40 text-sidebar-foreground/45"}`}>
                    <span className="font-semibold">
                      {scale
                        ? `Scale: ${(pageScaleChips[page] ?? []).find((c) => c.id === activeChipId[page])?.raw ?? "custom"}`
                        : (pageScaleChips[page] !== undefined ? "No scale found" : "Reading page…")}
                    </span>
                    <div className="flex items-center gap-1">
                      {(pageScaleChips[page] ?? []).map((chip) => (
                        <button
                          key={chip.id}
                          onClick={() => setActiveChipId((prev) => ({ ...prev, [page]: chip.id }))}
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${chip.id === activeChipId[page] ? "bg-emerald-600 text-white" : "bg-emerald-500/20 text-emerald-700 hover:bg-emerald-500/40"}`}
                          title={`Use scale ${chip.raw}`}
                        >{chip.raw}</button>
                      ))}
                      <button
                        onClick={() => { switchTool("setscale"); setScaleModeStep(0); setScaleAnchor(null); }}
                        className={`ml-0.5 rounded-full p-0.5 transition-colors hover:text-emerald-600 ${tool === "setscale" ? "text-amber-500" : "text-emerald-700/50"}`}
                        title="Manually calibrate scale"
                        aria-label="Calibrate scale"
                      ><Scaling size={12} /></button>
                    </div>
                  </div>
                )}
                <div className="mb-3 flex items-center justify-between">
                  <p className="eyebrow text-sidebar-accent-foreground/70">Tools</p>
                  <button className="icon-button-dark md:hidden" onClick={() => setMobileTools(false)} aria-label="Close"><X size={16} /></button>
                </div>

                {/* Markup group */}
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">Markup</p>
                <div className="grid grid-cols-5 gap-1 md:grid-cols-1 md:gap-1">
                  {toolMeta.filter((t) => t.group === "markup").map(({ id, label, shortcut, icon: Icon }) => (
                    <button key={id} onClick={() => { switchTool(id); setMobileTools(false); }} className={`tool-button ${tool === id ? "tool-button-active" : ""}`} aria-pressed={tool === id}>
                      <Icon size={17} /><span>{label}</span><kbd>{shortcut}</kbd>
                    </button>
                  ))}
                </div>

                <div className="my-3 h-px bg-sidebar-border" />

                {/* Precision group */}
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">Precision</p>
                <div className="grid grid-cols-3 gap-1 md:grid-cols-1 md:gap-1">
                  {toolMeta.filter((t) => t.group === "precision").map(({ id, label, shortcut, icon: Icon }) => (
                    <button key={id} onClick={() => { switchTool(id); setMobileTools(false); }} className={`tool-button ${tool === id ? "tool-button-active" : ""}`} aria-pressed={tool === id}>
                      <Icon size={17} /><span>{label}</span><kbd>{shortcut}</kbd>
                    </button>
                  ))}
                </div>

                <div className="my-3 h-px bg-sidebar-border" />

                {/* Color + thickness */}
                <div className="space-y-3">
                  <div>
                    <label className="eyebrow text-sidebar-foreground/55">Ink color</label>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {colors.map((c) => (<button key={c} onClick={() => setColor(c)} className={`color-dot ${color === c ? "color-dot-active" : ""}`} style={{ backgroundColor: c }} aria-label={`Color ${c}`} />))}
                      <label className="color-custom" aria-label="Custom color"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} /><span style={{ backgroundColor: color }} /></label>
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="eyebrow text-sidebar-foreground/55" htmlFor="thickness">Thickness</label>
                      <span className="font-mono text-[11px] text-sidebar-accent-foreground/80">{thickness}px</span>
                    </div>
                    <input id="thickness" type="range" min="1" max="18" value={thickness} onChange={(e) => setThickness(Number(e.target.value))} className="mt-2 w-full accent-[hsl(var(--sidebar-primary))]" />
                  </div>
                </div>

                <div className="my-3 h-px bg-sidebar-border" />

                <div className="grid grid-cols-2 gap-2">
                  <button className="side-action" disabled={!history.length} onClick={undo}><RotateCcw size={15} /> Undo</button>
                  <button className="side-action" disabled={!future.length}  onClick={redo}><RotateCw  size={15} /> Redo</button>
                </div>

                <div className="mt-auto hidden space-y-2 pt-5 md:block">
                  <button className="side-action w-full justify-start" onClick={() => setShowSchedule(true)}><ClipboardList size={16} /> Construction Schedule</button>
                  <button className="side-action w-full justify-start" onClick={() => { setPdfDoc(null); fileInputRef.current?.click(); }}><FilePlus2 size={16} /> Open another PDF</button>
                  <button className="side-action side-action-danger w-full justify-start" onClick={clearAll}><Trash2 size={16} /> Clear page markup</button>
                  <p className="pt-1 text-[10px] leading-relaxed text-sidebar-foreground/45">P pen · L line · D dim · A area · V select · ⌘Z undo · Shift = snap straight</p>
                </div>
              </div>
            </aside>

            {/* ── Canvas area ── */}
            <section className="flex min-h-0 min-w-0 flex-1 flex-col">
              {/* Toolbar */}
              <div className="flex min-h-[58px] shrink-0 items-center gap-3 border-b border-border bg-card px-3 md:px-5">
                {/* Left: mobile tools toggle — page nav moved to Pages panel */}
                <div className="flex min-w-0 items-center gap-2">
                  <button className="toolbar-button md:hidden" onClick={() => setMobileTools(!mobileTools)} aria-label="Toggle tools"><Menu size={17} /></button>
                  <div className="hidden h-6 w-px bg-border md:block" />
                </div>

                {/* Center: live dimension bar — visible when a line/area is in progress with scale set */}
                <div className="flex flex-1 items-center justify-center">
                  {scale && liveAnchor && (
                    <div className="flex items-center gap-1 rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5 shadow-sm">
                      <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-primary/60">L</span>
                      <input
                        ref={ftInputRef}
                        type="text"
                        inputMode="numeric"
                        value={dimFt}
                        onChange={(e) => { setDimFt(e.target.value.replace(/[^0-9]/g, "")); setDimIn(""); setDimEditing(true); }}
                        onFocus={() => setDimEditing(true)}
                        onBlur={() => setTimeout(() => setDimEditing(false), 150)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleDimEnter(); } if (e.key === "Tab") { e.preventDefault(); inInputRef.current?.focus(); } if (e.key === "Escape") setDimEditing(false); }}
                        className="w-10 bg-transparent text-center font-mono text-sm font-bold text-sidebar outline-none"
                        placeholder="0"
                        aria-label="Feet"
                      />
                      <span className="text-[11px] font-semibold text-muted-foreground">ft</span>
                      <span className="mx-1 text-muted-foreground/40">–</span>
                      <input
                        ref={inInputRef}
                        type="text"
                        value={dimIn}
                        onChange={(e) => { setDimIn(e.target.value.replace(/[^0-9\s/.]/g, "")); setDimEditing(true); }}
                        onFocus={() => setDimEditing(true)}
                        onBlur={() => setTimeout(() => setDimEditing(false), 150)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleDimEnter(); ftInputRef.current?.focus(); } if (e.key === "Escape") setDimEditing(false); }}
                        className="w-16 bg-transparent text-center font-mono text-sm font-bold text-sidebar outline-none"
                        placeholder="0"
                        aria-label="Inches (accepts fractions e.g. 6 1/16)"
                      />
                      <span className="text-[11px] font-semibold text-muted-foreground">"</span>
                      {dimEditing && (
                        <button
                          onClick={handleDimEnter}
                          className="ml-1.5 rounded-md bg-primary px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-primary/90"
                        >↵</button>
                      )}
                    </div>
                  )}
                </div>

                {/* Right: zoom + actions — tips moved to fixed tip bar below */}
                <div className="flex items-center gap-1.5">
                  {/* Zoom grid widget — Z/X active, Q/W reserved for future */}
                  {!zoomDrawing && (
                    <div className="flex items-center gap-1.5">
                      <div className="hidden flex-col items-center gap-0.5 sm:flex">
                        <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/45">Zoom</span>
                        <button
                          className="text-[8px] font-bold uppercase tracking-widest text-muted-foreground/35 transition-colors hover:text-red-500 hover:[text-shadow:0_0_6px_rgba(239,68,68,0.8)]"
                          onClick={() => { setZoomBoxZ(null); setZoomBoxX(null); setActiveZoom(null); setZoomCorner1(null); }}
                          title="Clear all zoom boxes"
                        >Clear</button>
                      </div>
                      {/* 2×2 grid — keyboard layout: Q/W top, Z/X bottom */}
                      <div className="grid grid-cols-2 gap-px overflow-hidden rounded border border-border bg-border shadow-sm">
                        {/* Q and W — top row, reserved for future */}
                        {(['q','w'] as const).map((key) => (
                          <button
                            key={key}
                            disabled
                            className="flex h-[22px] w-[22px] cursor-not-allowed items-center justify-center bg-card text-[10px] font-bold uppercase text-muted-foreground/20"
                            title={`${key.toUpperCase()} zoom — future slot`}
                          >
                            {key.toUpperCase()}
                          </button>
                        ))}
                        {/* Z and X — bottom row, active */}
                        {([ ['z', zoomBoxZ], ['x', zoomBoxX] ] as const).map(([key, box]) => (
                          <button
                            key={key}
                            className={`relative flex h-[22px] w-[22px] items-center justify-center text-[10px] font-bold uppercase transition-colors ${
                              activeZoom === key
                                ? "bg-primary text-white"
                                : box
                                  ? "bg-primary/10 text-primary hover:bg-primary/25"
                                  : "bg-card text-muted-foreground/60 hover:bg-accent hover:text-foreground"
                            }`}
                            onClick={() => {
                              if (activeZoom === key) setActiveZoom(null);
                              else if (box)           setActiveZoom(key as 'z'|'x');
                              else { setActiveZoom(null); setZoomDrawTarget(key as 'z'|'x'); setZoomDrawing(true); setZoomDrawStart(null); }
                            }}
                            title={
                              activeZoom === key ? `${key.toUpperCase()} — click or press ${key.toUpperCase()} to fit · Shift+${key.toUpperCase()} to redraw`
                              : box              ? `${key.toUpperCase()} — click or press ${key.toUpperCase()} to zoom in · Shift+${key.toUpperCase()} to redraw`
                              :                   `Draw ${key.toUpperCase()} zoom box (press ${key.toUpperCase()})`
                            }
                          >
                            {key.toUpperCase()}
                            {box && activeZoom !== key && (
                              <span className="absolute right-0.5 top-0.5 size-1 rounded-full bg-primary/60" />
                            )}
                          </button>
                        ))}
                      </div>
                      {/* Fit — only when zoomed */}
                      {activeZoom && (
                        <button
                          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                          onClick={() => setActiveZoom(null)}
                          title="Return to full view"
                        >
                          <Maximize2 size={12} /> Fit
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Scale calibration dialog strip */}
              {tool === "setscale" && scaleModeStep === 2 && scaleAnchor && scaleEnd && (
                <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3">
                  <Scaling size={16} className="shrink-0 text-amber-600" />
                  <span className="text-sm font-medium text-amber-800">How long is that line?</span>
                  <input type="number" value={scaleFt} onChange={(e) => setScaleFt(e.target.value)} placeholder="Feet" className="w-20 rounded border border-amber-300 bg-white px-2 py-1 text-sm" min="0" />
                  <span className="text-amber-600">ft</span>
                  <input type="number" value={scaleIn} onChange={(e) => setScaleIn(e.target.value)} placeholder="Inches" className="w-20 rounded border border-amber-300 bg-white px-2 py-1 text-sm" min="0" max="11" />
                  <span className="text-amber-600">in</span>
                  <button onClick={commitScale} className="rounded-lg bg-amber-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-amber-700">Set Scale</button>
                  <button onClick={() => { setScaleModeStep(0); setScaleAnchor(null); setScaleEnd(null); }} className="text-xs text-amber-600 underline">Cancel</button>
                </div>
              )}

              {/* ── Unified tip bar — fixed height, all context hints live here ── */}
              <div className="flex h-9 shrink-0 items-center gap-2 overflow-hidden border-y border-primary/15 bg-primary/[0.035] px-4">
                {zoomDrawing ? (
                  <>
                    <ScanSearch size={13} className="shrink-0 text-primary" />
                    <span className="text-[11px] font-medium text-primary">
                      {zoomCorner1 ? "Click second corner to set zoom area" : "Drag or click first corner of zoom area"}
                    </span>
                    <button onClick={() => { setZoomDrawing(false); setZoomDrawStart(null); setZoomCorner1(null); }} className="ml-auto text-[11px] text-primary/60 underline hover:text-primary">Cancel</button>
                  </>
                ) : tool === "setscale" ? (
                  <>
                    <Scaling size={13} className="shrink-0 text-amber-500" />
                    <span className="text-[11px] font-medium text-amber-700">
                      {scaleModeStep === 0 ? "Click first reference point on the drawing" : scaleModeStep === 1 ? "Click second reference point" : "Enter the real distance below, then Set Scale"}
                    </span>
                  </>
                ) : tool === "pen" ? (
                  <span className="text-[11px] font-medium text-primary/60">Pen — draw freehand · Esc=cancel</span>
                ) : tool === "highlight" ? (
                  <span className="text-[11px] font-medium text-primary/60">Highlight — drag to highlight an area · Esc=cancel</span>
                ) : tool === "eraser" ? (
                  <span className="text-[11px] font-medium text-primary/60">Eraser — drag over markup to erase · Esc=cancel</span>
                ) : tool === "text" ? (
                  <span className="text-[11px] font-medium text-primary/60">Text note — click anywhere to place a note · Esc=cancel</span>
                ) : tool === "area" ? (
                  areaPoints.length === 0
                    ? <span className="text-[11px] font-medium text-primary/70">Area — click to add points · Space/Enter=close polygon · Esc=cancel</span>
                    : <span className="text-[11px] font-medium text-primary/70">
                        {areaPoints.length} {areaPoints.length === 1 ? "point" : "points"} placed —{" "}
                        {areaPoints.length >= 3 ? "Space/Enter or click the first point to close" : "keep clicking · need 3+ points"} · Esc=cancel
                      </span>
                ) : tool === "line" ? (
                  !lineAnchor
                    ? <span className="text-[11px] font-medium text-primary/70">Line — click start point · Esc=cancel</span>
                    : customAngleLock !== null
                      ? <><span className="mr-1 size-1.5 shrink-0 rounded-full bg-amber-500 inline-block" /><span className="text-[11px] font-medium text-amber-700">Direction locked — type length in the box and press Enter · Esc=cancel</span></>
                      : <span className="text-[11px] font-medium text-primary/70">Click end point · <kbd className="rounded bg-primary/10 px-1 py-px font-mono text-[10px]">L</kbd>/<kbd className="rounded bg-primary/10 px-1 py-px font-mono text-[10px]">R</kbd>=lock axis · <kbd className="rounded bg-primary/10 px-1 py-px font-mono text-[10px]">Ctrl</kbd>=45° snap · type length+Enter · Esc=cancel</span>
                ) : tool === "dimension" ? (
                  !lineAnchor
                    ? <span className="text-[11px] font-medium text-primary/70">Dimension — click start point · Esc=cancel</span>
                    : <span className="text-[11px] font-medium text-primary/70">{mousePos && previewPt ? measureDistance(lineAnchor, previewPt, pageAspect, scale) : "Click end point"} · Space/Enter=done · Esc=cancel</span>
                ) : (
                  <span className="select-none text-[10px] font-semibold uppercase tracking-widest text-primary/20">
                    Line · Dimension · Area · Z/X zoom
                  </span>
                )}
              </div>

              {/* Stage — fills available space, PDF letterboxed inside */}
              <div className="workspace-grid relative min-h-0 flex-1 overflow-hidden">
                {/* absolute inset-0 gives the flex centering div explicit pixel dimensions
                    so maxHeight/maxWidth percentages on the stageRef resolve correctly */}
                <div ref={stageContainerRef} className="absolute inset-0 flex items-center justify-center p-4">
                    <div
                      ref={stageRef}
                      className={`relative overflow-hidden rounded-[3px] bg-white shadow-[0_18px_42px_rgba(29,58,84,.18)] ring-1 ring-black/10 ${cursorClass}`}
                      style={stagePx
                        ? { width: stagePx.w, height: stagePx.h }
                        : { aspectRatio: `1 / ${pageAspect}`, maxHeight: "100%", maxWidth: "100%" }}
                      onPointerDown={pointerDown}
                      onPointerMove={pointerMove}
                      onPointerUp={pointerUp}
                      onPointerCancel={pointerUp}
                      onPointerLeave={() => setMousePos(null)}
                      onDoubleClick={() => {
                        if (tool === "line" && lineAnchor) {
                          setLineAnchor(null);
                          setCustomAngleLock(null);
                          setLockedAngle(null);
                        }
                      }}
                      onClick={(e) => { if (tool === "select" && e.target === e.currentTarget) setSelectedId(null); }}
                    >
                      {/* Inner zoom transform wrapper — scale/translate applies here */}
                      <div
                        className="absolute inset-0"
                        style={(() => {
                          const ab = activeZoom === 'z' ? zoomBoxZ : activeZoom === 'x' ? zoomBoxX : null;
                          return ab ? {
                            transformOrigin: "0 0",
                            transform: computeZoomTransform(ab),
                            transition: "transform 0.18s ease-out",
                          } : { transition: "transform 0.18s ease-out" };
                        })()}
                      >

                      {/* PDF canvas */}
                      <canvas ref={pdfCanvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />

                      {/* 2× dimension overlay — shows only dimension-like strings, placed beside originals */}
                      {showTextOverlay && stagePx && (pageTextItems[page] ?? []).length > 0 && (
                        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
                          {(pageTextItems[page] ?? []).filter((item) => isDimension(item.str)).map((item, i) => {
                            const origPx  = item.fs * stagePx.h;           // original font size in px
                            const bigPx   = origPx * 2;                    // 2× size
                            // Estimate original text width to offset the 2× label beside it
                            const origW   = item.str.length * origPx * 0.58;
                            const baseLft = item.x * stagePx.w;
                            const baseTop = item.y * stagePx.h;
                            const deg     = -(item.angle * 180) / Math.PI;
                            // Offset in screen-space to the right of the original, along its baseline direction
                            const rad     = item.angle;
                            const gap     = 4;
                            const offX    = Math.cos(rad) * (origW + gap);
                            const offY    = -Math.sin(rad) * (origW + gap);
                            return (
                              <span
                                key={i}
                                style={{
                                  position:        "absolute",
                                  left:            `${baseLft + offX}px`,
                                  top:             `${baseTop + offY}px`,
                                  fontSize:        `${bigPx}px`,
                                  lineHeight:      1,
                                  transformOrigin: "left bottom",
                                  transform:       `rotate(${deg}deg) translateY(-100%)`,
                                  whiteSpace:      "pre",
                                  color:           "#b45309",   // amber-700 — readable on white
                                  background:      "rgba(255,251,235,0.92)",
                                  padding:         "0 2px",
                                  borderRadius:    "2px",
                                  outline:         "1px solid rgba(180,83,9,0.25)",
                                  fontFamily:      "sans-serif",
                                  fontWeight:      700,
                                  pointerEvents:   "none",
                                  userSelect:      "none",
                                }}
                              >{item.str}</span>
                            );
                          })}
                        </div>
                      )}

                      {/* Magnifying loupe — follows cursor, M key toggles */}
                      {!!loupeStage && mousePos && stagePx && (() => {
                        const LOUPE_CSS = loupeStage === 2 ? 464 : 220;
                        const cx = mousePos.x / 1000 * stagePx.w;
                        const cy = mousePos.y / 1000 * stagePx.h;
                        // Position loupe centred on cursor; keep it inside stage bounds
                        const lx = Math.max(0, Math.min(stagePx.w - LOUPE_CSS, cx - LOUPE_CSS / 2));
                        const ly = Math.max(0, Math.min(stagePx.h - LOUPE_CSS, cy - LOUPE_CSS / 2));
                        return (
                          <div
                            style={{
                              position:     "absolute",
                              left:         lx,
                              top:          ly,
                              width:        LOUPE_CSS,
                              height:       LOUPE_CSS,
                              borderRadius: "50%",
                              overflow:     "hidden",
                              border:       "2px solid rgba(180,83,9,0.7)",
                              boxShadow:    "0 4px 24px rgba(0,0,0,0.35)",
                              pointerEvents:"none",
                              zIndex:       50,
                            }}
                            aria-hidden
                          >
                            <canvas
                              ref={loupeCanvasRef}
                              style={{ width: LOUPE_CSS, height: LOUPE_CSS, display: "block" }}
                            />
                          </div>
                        );
                      })()}

                      {/* SVG markup + preview overlay */}
                      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1000 1000" preserveAspectRatio="none">

                        {/* Completed markup — rendered from memoized list, not rebuilt on every pointer move */}
                        {completedMarkupSvg}

                        {/* Line / dimension preview */}
                        {lineAnchor && previewPt && (tool === "line" || tool === "dimension") && (
                          <line x1={lineAnchor.x} y1={lineAnchor.y} x2={previewPt.x} y2={previewPt.y} stroke={color} strokeWidth={tool === "line" ? thickness : 2} strokeDasharray="10,5" opacity={0.65} />
                        )}

                        {/* Snap ring — shows only when the line endpoint is actually snapped to a node */}
                        {lineEffectiveExisting && (tool === "line" || tool === "dimension") && lineAnchor && (
                          <>
                            <circle cx={lineEffectiveExisting.x} cy={lineEffectiveExisting.y} r={NODE_SIZE} fill="none" stroke="#22d3ee" strokeWidth={1.5} opacity={0.9} />
                            <circle cx={lineEffectiveExisting.x} cy={lineEffectiveExisting.y} r={NODE_RADIUS} fill="#22d3ee" opacity={0.8} />
                          </>
                        )}

                        {/* Area preview */}
                        {areaPoints.length > 0 && previewAreaPt && (
                          <>
                            <polygon points={[...areaPoints, previewAreaPt].map((p)=>`${p.x},${p.y}`).join(" ")} fill={color} fillOpacity={0.08} stroke={color} strokeWidth={2} strokeDasharray="10,5" strokeLinejoin="round" />
                            {areaPoints.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={NODE_RADIUS} fill={color} opacity={0.8} />)}
                            {areaPoints.length >= 3 && Math.hypot(previewAreaPt.x - areaPoints[0].x, previewAreaPt.y - areaPoints[0].y) < 3 && (
                              <circle cx={areaPoints[0].x} cy={areaPoints[0].y} r={NODE_SIZE} fill={color} fillOpacity={0.25} stroke={color} strokeWidth={1.5} />
                            )}
                          </>
                        )}

                        {/* Scale calibration preview */}
                        {tool === "setscale" && scaleAnchor && scaleModeStep === 1 && scalePreviewPt && (
                          <line x1={scaleAnchor.x} y1={scaleAnchor.y} x2={scalePreviewPt.x} y2={scalePreviewPt.y} stroke="#f59e0b" strokeWidth={2} strokeDasharray="8,4" />
                        )}
                        {tool === "setscale" && scaleAnchor && scaleModeStep >= 1 && (
                          <circle cx={scaleAnchor.x} cy={scaleAnchor.y} r={NODE_RADIUS} fill="#f59e0b" />
                        )}
                        {tool === "setscale" && scaleEnd && (
                          <circle cx={scaleEnd.x} cy={scaleEnd.y} r={NODE_RADIUS} fill="#f59e0b" />
                        )}

                        {/* Zoom box rubber-band — shown during drag or after first corner click */}
                        {zoomDrawing && (zoomDrawStart ?? zoomCorner1) && mousePos && (() => {
                          const origin = zoomCorner1 ?? zoomDrawStart!;
                          const rx = Math.min(origin.x, mousePos.x);
                          const ry = Math.min(origin.y, mousePos.y);
                          const rw = Math.abs(mousePos.x - origin.x);
                          const rh = Math.abs(mousePos.y - origin.y);
                          return (
                            <>
                              <rect x={rx} y={ry} width={rw} height={rh} fill="rgba(59,130,246,0.08)" stroke="#3b82f6" strokeWidth={2} strokeDasharray="8,4" />
                              <rect x={rx} y={ry} width={rw} height={rh} fill="none" stroke="white" strokeWidth={0.8} opacity={0.5} />
                            </>
                          );
                        })()}

                        {/* Existing-point snap indicator (axis-filtered when direction-locked) */}
                        {(lineEffectiveExisting ?? areaEffectiveExisting) && (tool === "line" || tool === "dimension" || tool === "area") && (() => {
                          const pt = lineEffectiveExisting ?? areaEffectiveExisting!;
                          return (
                            <>
                              <circle cx={pt.x} cy={pt.y} r={NODE_SIZE} fill="none" stroke="var(--color-primary)" strokeWidth={1.5} opacity={0.9} />
                              <circle cx={pt.x} cy={pt.y} r={NODE_RADIUS} fill="var(--color-primary)" opacity={0.85} />
                            </>
                          );
                        })()}

                        {/* Projected-axis snap indicator — dashed reference line from source point to locked-axis snap */}
                        {!(lineEffectiveExisting ?? areaEffectiveExisting) && (lineProjected || areaProjected) && (() => {
                          const proj = lineProjected ?? areaProjected!;
                          return (
                            <>
                              {/* Dashed reference line from the source existing point to the snap position */}
                              <line
                                x1={proj.source.x} y1={proj.source.y}
                                x2={proj.snapped.x} y2={proj.snapped.y}
                                stroke="var(--color-primary)" strokeWidth={1.5}
                                strokeDasharray="6,4" opacity={0.55}
                              />
                              {/* Small dot on source point */}
                              <circle cx={proj.source.x} cy={proj.source.y} r={NODE_RADIUS} fill="none" stroke="var(--color-primary)" strokeWidth={1} opacity={0.6} />
                              {/* Snap ring on locked-axis position */}
                              <circle cx={proj.snapped.x} cy={proj.snapped.y} r={NODE_SIZE} fill="none" stroke="var(--color-primary)" strokeWidth={1.5} opacity={0.9} />
                              <circle cx={proj.snapped.x} cy={proj.snapped.y} r={NODE_RADIUS} fill="var(--color-primary)" opacity={0.85} />
                            </>
                          );
                        })()}
                      </svg>

                      {/* Text markup click targets */}
                      {pageMarkup.filter((m) => m.kind === "text").map((m) => (
                        <button key={m.id} className={`absolute -translate-y-1/2 bg-transparent p-0 text-left font-semibold ${selectedId === m.id ? "rounded-sm outline outline-2 outline-[hsl(var(--accent))]" : ""}`}
                          style={{ left: `${((m.x??0)/1000)*100}%`, top: `${((m.y??0)/1000)*100}%`, color: m.color, fontSize: "clamp(10px,1.5vw,18px)" }}
                          onClick={(e) => { e.stopPropagation(); setSelectedId(m.id); }}>{m.text}</button>
                      ))}

                      {/* Active tool badge */}
                      {tool !== "select" && !zoomDrawing && (
                        <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-sidebar px-2.5 py-1.5 text-[10px] font-medium text-sidebar-foreground shadow-sm animate-fade">
                          {tool === "setscale" ? "Set Scale" : toolMeta.find((t) => t.id === tool)?.label} active
                          {tool === "line" && lineAnchor ? " · click end point" : ""}
                        </div>
                      )}

                      {/* Zoom drawing overlay badge */}
                      {zoomDrawing && (
                        <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-primary px-2.5 py-1.5 text-[10px] font-medium text-white shadow-sm">
                          Draw zoom box
                        </div>
                      )}
                      </div>{/* ── close inner zoom transform wrapper ── */}

                    </div>{/* ── close stageRef ── */}
                </div>{/* ── close absolute centering div ── */}
              </div>{/* ── close workspace-grid ── */}
            </section>

            {/* ── Pages panel (collapsed) ── */}
            <aside className="hidden shrink-0 border-l border-border bg-card md:flex md:flex-col" style={{ width: "200px" }}>
              <div className="flex items-center justify-between border-b border-border px-3 py-3">
                <div>
                  <p className="eyebrow text-primary">Pages</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{pageCount} {pageCount === 1 ? "sheet" : "sheets"}</p>
                </div>
                <div className="flex items-center gap-0.5">
                  <button className="toolbar-button" disabled={page <= 1} onClick={() => { setPage((p) => p - 1); setLineAnchor(null); setAreaPoints([]); }} aria-label="Previous page"><ChevronLeft size={14} /></button>
                  <span className="min-w-[52px] text-center text-[11px] font-semibold tabular-nums">{page} / {pageCount}</span>
                  <button className="toolbar-button" disabled={page >= pageCount} onClick={() => { setPage((p) => p + 1); setLineAnchor(null); setAreaPoints([]); }} aria-label="Next page"><ChevronRight size={14} /></button>
                </div>
              </div>
              <div className="flex-1 space-y-1.5 overflow-y-auto p-2">
                {pageNums.map((n) => {
                  const hasMarkup = markup.some((m) => m.page === n);
                  const ratio = pageAspects[n] ?? 1.294; // h/w, fallback portrait
                  return (
                    <button key={n} onClick={() => { setPage(n); setLineAnchor(null); setAreaPoints([]); }} className={`group w-full text-left ${page === n ? "text-primary" : "text-muted-foreground"}`} aria-label={`Page ${n}`} aria-pressed={page === n}>
                      <div className={`relative overflow-hidden rounded-md border bg-white shadow-sm transition`} style={{ aspectRatio: `1 / ${ratio}`, ...(page === n ? { borderColor: "hsl(var(--primary))", boxShadow: "0 0 0 2px hsl(var(--primary)/0.2)" } : {}) }}>
                        <PageThumbnail pdfDoc={pdfDoc} pageNum={n} onAspect={(r) => setPageAspects((prev) => ({ ...prev, [n]: r }))} />
                        {page === n && <div className="absolute bottom-1 right-1 rounded bg-primary px-1.5 py-0.5 font-mono text-[9px] text-primary-foreground">OPEN</div>}
                        {hasMarkup && <div className="absolute left-1 top-1 size-1.5 rounded-full bg-accent" />}
                      </div>
                      <div className="mt-0.5 font-mono text-[9px] text-muted-foreground/60">PAGE {String(n).padStart(2, "0")}</div>
                    </button>
                  );
                })}
              </div>
            </aside>

            {/* ── Pages drawer (expanded) ── */}
            {pagesExpanded && (
              <div className="fixed inset-0 z-40 flex" onClick={() => setPagesExpanded(false)}>
                {/* Backdrop */}
                <div className="flex-1 bg-sidebar/40 backdrop-blur-[2px]" />
                {/* Drawer panel */}
                <div
                  className="relative flex h-full flex-col border-l border-border bg-card shadow-2xl"
                  style={{ width: "min(80vw, 900px)" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Header */}
                  <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
                    <div>
                      <p className="eyebrow text-primary">Pages</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{pageCount} {pageCount === 1 ? "sheet" : "sheets"} — click any page to open it</p>
                  <div className="mt-1 flex items-center gap-0.5">
                    <button className="toolbar-button" disabled={page <= 1} onClick={() => { setPage((p) => p - 1); setLineAnchor(null); setAreaPoints([]); }} aria-label="Previous page"><ChevronLeft size={14} /></button>
                    <span className="min-w-[52px] text-center text-[11px] font-semibold tabular-nums">Page {page} / {pageCount}</span>
                    <button className="toolbar-button" disabled={page >= pageCount} onClick={() => { setPage((p) => p + 1); setLineAnchor(null); setAreaPoints([]); }} aria-label="Next page"><ChevronRight size={14} /></button>
                  </div>
                    </div>
                    <button onClick={() => setPagesExpanded(false)} className="toolbar-button" title="Collapse" aria-label="Collapse page browser">
                      <ChevronRight size={16} />
                    </button>
                  </div>
                  {/* Grid */}
                  <div className="flex-1 overflow-y-auto p-5">
                    <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                      {pageNums.map((n) => {
                        const hasMarkup = markup.some((m) => m.page === n);
                        const ratio = pageAspects[n] ?? 1.294;
                        return (
                          <button
                            key={n}
                            onClick={() => { setPage(n); setLineAnchor(null); setAreaPoints([]); setPagesExpanded(false); }}
                            className={`group w-full text-left ${page === n ? "text-primary" : "text-muted-foreground"}`}
                            aria-label={`Page ${n}`}
                          >
                            <div className={`relative overflow-hidden rounded-lg border bg-white shadow-sm transition ${page === n ? "border-primary ring-2 ring-primary/20" : "border-border group-hover:border-primary/50"}`} style={{ aspectRatio: `1 / ${ratio}` }}>
                              <PageThumbnail pdfDoc={pdfDoc} pageNum={n} onAspect={(r) => setPageAspects((prev) => ({ ...prev, [n]: r }))} />
                              {page === n && <div className="absolute bottom-1.5 right-1.5 rounded bg-primary px-1.5 py-0.5 font-mono text-[9px] text-primary-foreground">OPEN</div>}
                              {hasMarkup && <div className="absolute left-1.5 top-1.5 size-1.5 rounded-full bg-accent" />}
                            </div>
                            <div className="mt-1 text-center font-mono text-[10px]">PAGE {String(n).padStart(2, "0")}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Category picker ── */}
      {showCatPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-sidebar/40 backdrop-blur-[2px]" role="dialog">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-2xl animate-rise">

            {!showPitchPicker ? (
              /* ── Step 1: choose category ── */
              <>
                <p className="eyebrow text-primary">Area type</p>
                <h2 className="mt-2 text-lg font-semibold tracking-tight text-sidebar">What kind of area is this?</h2>
                <div className="mt-3 flex rounded-lg border border-border p-0.5">
                  <button onClick={() => setPickerSheetType("plan")} className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition ${pickerSheetType === "plan" ? "bg-primary text-white shadow-sm" : "text-muted-foreground hover:text-sidebar"}`}>Floor Plan</button>
                  <button onClick={() => setPickerSheetType("elevation")} className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition ${pickerSheetType === "elevation" ? "bg-primary text-white shadow-sm" : "text-muted-foreground hover:text-sidebar"}`}>Elevation</button>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {(pickerSheetType === "elevation" ? elevationCategories : areaCategories).map((cat) => (
                    <button key={cat.id} onClick={() => commitArea(cat.id)} className="flex items-center gap-2.5 rounded-xl border border-border px-3 py-3 text-left text-sm font-semibold text-sidebar transition hover:border-primary hover:bg-primary/5">
                      <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: cat.color }} />
                      {cat.label}
                    </button>
                  ))}
                </div>
                <button onClick={() => { setPendingPoly(null); setShowCatPicker(false); }} className="mt-4 w-full text-center text-xs text-muted-foreground underline">Cancel</button>
              </>
            ) : (
              /* ── Step 2: roof pitch ── */
              <>
                <p className="eyebrow text-primary">Roof slope</p>
                <h2 className="mt-2 text-lg font-semibold tracking-tight text-sidebar">What is the roof pitch?</h2>
                {pageRoofPitch[page] && pageRoofPitch[page] === selectedPitch && (
                  <p className="mt-1 text-xs text-muted-foreground">Auto-detected from plan — change if incorrect.</p>
                )}

                {/* Pitch dropdown */}
                <div className="mt-4">
                  <label className="mb-1.5 block text-xs font-semibold text-sidebar">Pitch (rise : 12 run)</label>
                  <select
                    value={selectedPitch}
                    onChange={(e) => setSelectedPitch(e.target.value)}
                    className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-sidebar outline-none focus:border-primary"
                  >
                    {ROOF_PITCHES.map((p) => (
                      <option key={p.label} value={p.label}>
                        {p.label} — ×{slopeMultiplier(p.rise).toFixed(3)}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Live flat vs adjusted preview */}
                {(() => {
                  const rise = ROOF_PITCHES.find((p) => p.label === selectedPitch)?.rise ?? 6;
                  const adj = Math.round(pendingSqFt * slopeMultiplier(rise));
                  return (
                    <div className="mt-4 grid grid-cols-2 gap-2">
                      <div className="rounded-xl border border-border bg-muted/30 p-3 text-center">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Flat footprint</p>
                        <p className="mt-1 font-mono text-xl font-bold text-sidebar">{Math.round(pendingSqFt).toLocaleString()}</p>
                        <p className="text-[10px] text-muted-foreground">sq ft</p>
                      </div>
                      <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-center">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-primary/70">Actual @ {selectedPitch}</p>
                        <p className="mt-1 font-mono text-xl font-bold text-primary">{adj.toLocaleString()}</p>
                        <p className="text-[10px] text-muted-foreground">sq ft</p>
                      </div>
                    </div>
                  );
                })()}

                <div className="mt-4 flex gap-2">
                  <button onClick={() => setShowPitchPicker(false)} className="flex-1 rounded-xl border border-border py-2.5 text-sm font-semibold text-muted-foreground transition hover:border-primary hover:text-sidebar">← Back</button>
                  <button onClick={commitRoofArea} className="flex-1 rounded-xl bg-primary py-2.5 text-sm font-semibold text-white transition hover:bg-primary/90">Add to schedule</button>
                </div>
                <button onClick={() => { setPendingPoly(null); setShowCatPicker(false); setShowPitchPicker(false); }} className="mt-3 w-full text-center text-xs text-muted-foreground underline">Cancel</button>
              </>
            )}

          </div>
        </div>
      )}

      {/* ── Construction Schedule ── */}
      {showSchedule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-sidebar/40 p-4 backdrop-blur-[2px]" role="dialog" onClick={() => setShowSchedule(false)}>
          <div className="flex w-full max-w-2xl flex-col max-h-[88vh] rounded-2xl border border-border bg-card shadow-2xl animate-rise" onClick={(e) => e.stopPropagation()}>

            {/* Header */}
            <div className="flex shrink-0 items-start justify-between border-b border-border px-6 py-5">
              <div>
                <p className="eyebrow text-primary">Takeoff</p>
                <h2 className="mt-1 text-xl font-semibold tracking-tight text-sidebar">Construction Schedule</h2>
                <p className="mt-1 text-xs text-muted-foreground">{fileName}</p>
              </div>
              <button onClick={() => setShowSchedule(false)} className="toolbar-button" aria-label="Close"><X size={17} /></button>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

              {/* Empty state */}
              {schedulePlan.length === 0 && scheduleElevation.length === 0 &&
               !scheduleAreas.some((a) => a.slopePitch) &&
               (scannedSchedule === null || (scannedSchedule.scanning === false &&
                 scannedSchedule.doors.length === 0 && scannedSchedule.windows.length === 0 && scannedSchedule.garageDoors.length === 0)) && (
                <div className="rounded-xl border border-dashed border-border py-10 text-center">
                  <Pentagon size={32} className="mx-auto text-muted-foreground/30" />
                  <p className="mt-3 text-sm font-medium text-sidebar">No data yet</p>
                  <p className="mt-1 text-xs text-muted-foreground">Draw areas with the Area tool, or open a vector PDF so doors and windows can be detected.</p>
                </div>
              )}

              {/* Floor plan areas */}
              {schedulePlan.length > 0 && (
                <section>
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Floor Plan Areas</p>
                  <div className="space-y-2">{schedulePlan.map((cat) => <ScheduleRow key={cat.id} cat={cat} />)}</div>
                  <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                    <span className="text-xs font-semibold text-sidebar">Plan total</span>
                    <span className="font-mono text-sm font-bold text-primary">{Math.round(schedulePlan.reduce((s, c) => s + c.total, 0)).toLocaleString()} sq ft</span>
                  </div>
                </section>
              )}

              {/* Exterior / elevation areas */}
              {scheduleElevation.length > 0 && (
                <section>
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Exterior Finish Areas</p>
                  <div className="space-y-2">{scheduleElevation.map((cat) => <ScheduleRow key={cat.id} cat={cat} />)}</div>
                  <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                    <span className="text-xs font-semibold text-sidebar">Elevation total</span>
                    <span className="font-mono text-sm font-bold text-primary">{Math.round(scheduleElevation.reduce((s, c) => s + c.total, 0)).toLocaleString()} sq ft</span>
                  </div>
                </section>
              )}

              {/* Grand total */}
              {schedulePlan.length > 0 && scheduleElevation.length > 0 && (
                <div className="flex items-center justify-between border-t-2 border-border pt-3">
                  <span className="text-sm font-bold text-sidebar">Grand total</span>
                  <span className="font-mono text-lg font-bold text-primary">{Math.round(grandTotal).toLocaleString()} sq ft</span>
                </div>
              )}

              {/* Roof pitch summary (from drawn areas) */}
              {scheduleAreas.some((a) => a.slopePitch) && (
                <section>
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Roof Pitch</p>
                  <div className="divide-y divide-border rounded-lg border border-border">
                    {Array.from(new Set(scheduleAreas.filter((a) => a.slopePitch).map((a) => a.slopePitch!))).map((pitch) => {
                      const cnt = scheduleAreas.filter((a) => a.slopePitch === pitch).length;
                      return (
                        <div key={pitch} className="flex items-center justify-between px-3 py-2">
                          <span className="font-mono text-sm font-medium text-sidebar">{pitch}</span>
                          <span className="text-xs text-muted-foreground">{cnt} area{cnt !== 1 ? "s" : ""}</span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Scanning indicator */}
              {scannedSchedule?.scanning && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="size-3 rounded-full border-2 border-primary border-t-transparent animate-spin inline-block" />
                  Scanning PDF for doors and windows…
                </div>
              )}

              {/* Auto-detected doors */}
              {scannedSchedule && !scannedSchedule.scanning && scannedSchedule.doors.length > 0 && (
                <section>
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Doors <span className="normal-case font-normal">(auto-detected)</span></p>
                  <div className="divide-y divide-border rounded-lg border border-border">
                    {scannedSchedule.doors.map((d) => (
                      <div key={d.key} className="flex items-center justify-between px-3 py-2">
                        <span className="font-mono text-sm font-medium text-sidebar">{d.key}</span>
                        <span className="text-xs text-muted-foreground">{d.count}×</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Auto-detected windows */}
              {scannedSchedule && !scannedSchedule.scanning && scannedSchedule.windows.length > 0 && (
                <section>
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Windows <span className="normal-case font-normal">(auto-detected)</span></p>
                  <div className="divide-y divide-border rounded-lg border border-border">
                    {scannedSchedule.windows.map((w) => (
                      <div key={w.key} className="flex items-center justify-between px-3 py-2">
                        <span className="font-mono text-sm font-medium text-sidebar">{w.key}</span>
                        <span className="text-xs text-muted-foreground">{w.count}×</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Auto-detected garage doors */}
              {scannedSchedule && !scannedSchedule.scanning && scannedSchedule.garageDoors.length > 0 && (
                <section>
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Garage Doors <span className="normal-case font-normal">(auto-detected)</span></p>
                  <div className="divide-y divide-border rounded-lg border border-border">
                    {scannedSchedule.garageDoors.map((g) => (
                      <div key={g.key} className="flex items-center justify-between px-3 py-2">
                        <span className="font-mono text-sm font-medium text-sidebar">{g.key}</span>
                        <span className="text-xs text-muted-foreground">{g.count}×</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* No openings found note */}
              {scannedSchedule && !scannedSchedule.scanning &&
               scannedSchedule.doors.length === 0 && scannedSchedule.windows.length === 0 && scannedSchedule.garageDoors.length === 0 && (
                <p className="text-xs italic text-muted-foreground">No doors or windows detected — only vector PDFs with a text layer can be scanned.</p>
              )}

              {/* Notes */}
              <section>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Notes</p>
                <textarea
                  value={scheduleNotes}
                  onChange={(e) => setScheduleNotes(e.target.value)}
                  placeholder="Additional notes, quantities, or callouts…"
                  className="w-full min-h-[80px] resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-sidebar placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </section>

            </div>
          </div>
        </div>
      )}

      {/* ── Export dialog ── */}
      {showExport && pdfDoc && (
        <ExportDialog exportType={exportType} setExportType={setExportType} exportRange={exportRange} setExportRange={setExportRange} dpi={dpi} setDpi={setDpi} onClose={() => setShowExport(false)} onExport={() => void exportDocument()} documentName={fileName} page={page} />
      )}

      {/* ── Select action bar ── */}
      {tool === "select" && selectedId && (() => {
        const sel = pageMarkup.find((m) => m.id === selectedId);
        if (!sel) return null;
        const cat = sel.kind === "area" ? allAreaCategories.find((c) => c.id === sel.category) : null;
        const kindLabel = sel.kind === "path" ? "Freehand" : sel.kind === "line" ? "Line" : sel.kind === "dimension" ? "Dimension" : sel.kind === "area" ? (cat?.label ?? "Area") : "Text note";
        return (
          <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-2xl border border-sidebar-border bg-sidebar px-3 py-2 shadow-xl animate-rise">
            {cat && <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: cat.color }} />}
            <span className="text-xs font-semibold text-sidebar-foreground">{kindLabel}</span>
            <span className="text-sidebar-foreground/30 text-xs">·</span>
            <span className="text-[10px] text-muted-foreground">drag to move</span>
            {sel.kind === "area" && (
              <>
                <span className="text-sidebar-foreground/30 text-xs">·</span>
                <button
                  className="rounded-lg border border-sidebar-border bg-card px-2.5 py-1 text-[11px] font-semibold text-sidebar transition hover:border-primary hover:text-primary"
                  onClick={() => {
                    const area = markup.find((m) => m.id === selectedId);
                    if (!area?.polygon) return;
                    setEditingAreaId(selectedId);
                    setPendingPoly(area.polygon);
                    setShowCatPicker(true);
                    setPickerSheetType(elevationCategories.some((c) => c.id === area.category) ? "elevation" : "plan");
                  }}
                >Change type</button>
              </>
            )}
            <span className="text-sidebar-foreground/30 text-xs">·</span>
            <button
              className="rounded-lg border border-sidebar-border bg-card px-2.5 py-1 text-[11px] font-semibold text-red-500 transition hover:border-red-400 hover:bg-red-50"
              onClick={removeSelected}
            >Delete</button>
          </div>
        );
      })()}

      {/* ── Toast ── */}
      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-sidebar px-4 py-2.5 text-xs font-medium text-sidebar-foreground shadow-lg animate-rise" role="status">
          <Check size={14} className="text-emerald-300" />{toast}
        </div>
      )}

      <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={onFileChange} />
      <input ref={sessionInputRef} type="file" accept=".mk" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadSession(f); e.target.value = ""; }} />
    </main>
  );
}

// ─── Page thumbnail ───────────────────────────────────────────────────────────
function PageThumbnail({ pdfDoc, pageNum, onAspect }: { pdfDoc: PDFDocumentProxy | null; pageNum: number; onAspect?: (ratio: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    let cancelled = false;
    (async () => {
      const pdfPage = await pdfDoc.getPage(pageNum);
      if (cancelled) return;
      const vp = pdfPage.getViewport({ scale: 0.3 });
      const canvas = canvasRef.current!;
      canvas.width = vp.width; canvas.height = vp.height;
      onAspect?.(vp.height / vp.width);
      await pdfPage.render({ canvasContext: canvas.getContext("2d")!, viewport: vp, canvas }).promise;
    })();
    return () => { cancelled = true; };
  }, [pdfDoc, pageNum]);
  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full object-contain" />;
}

// ─── Empty / landing state ────────────────────────────────────────────────────
function EmptyState({ fileInputRef, isLoading, error, onFileChange, onOpen }: { fileInputRef: RefObject<HTMLInputElement | null>; isLoading: boolean; error: string; onFileChange: (e: ChangeEvent<HTMLInputElement>) => void; onOpen: () => void }) {
  const [isDragging, setIsDragging] = useState(false);
  const turbRef = useRef<SVGFETurbulenceElement>(null);
  const dispRef = useRef<SVGFEDisplacementMapElement>(null);

  // Animate the water filter — very slow, organic turbulence shift
  useEffect(() => {
    let raf: number;
    let t = 0;
    const tick = () => {
      t += 0.0025; // glacially slow for gentle water feel
      if (turbRef.current) {
        const fx = 0.009 + Math.sin(t * 0.53) * 0.002;
        const fy = 0.013 + Math.cos(t * 0.37) * 0.003;
        turbRef.current.setAttribute("baseFrequency", `${fx.toFixed(5)} ${fy.toFixed(5)}`);
      }
      if (dispRef.current) {
        const sc = 6 + Math.sin(t * 0.71) * 2.5;
        dispRef.current.setAttribute("scale", sc.toFixed(2));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="relative min-h-[100dvh] overflow-hidden bg-[hsl(var(--background))]">

      {/* Hidden SVG — just carries the filter definition */}
      <svg style={{ position: "absolute", width: 0, height: 0 }}>
        <defs>
          <filter id="water-wave" x="-15%" y="-15%" width="130%" height="130%" colorInterpolationFilters="sRGB">
            <feTurbulence ref={turbRef} type="turbulence" baseFrequency="0.009 0.013" numOctaves="1" seed="5" result="noise" />
            <feDisplacementMap ref={dispRef} in="SourceGraphic" in2="noise" scale="6" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>

      {/* Dot-grid "paper" — this is what gets distorted by the water filter */}
      <div
        className="absolute inset-0 opacity-45"
        style={{
          backgroundImage: "radial-gradient(hsl(201 76% 42% / .18) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          filter: "url(#water-wave)",
        }}
      />

      {/* Subtle depth tint — barely-blue, like looking through shallow water */}
      <div className="absolute inset-0 bg-gradient-to-b from-[hsl(195_40%_93%/0.45)] via-transparent to-[hsl(210_45%_91%/0.30)]" />

      {/* Caustic light blobs — slow-moving, very low opacity */}
      <div className="water-caustic-a pointer-events-none absolute" style={{ width: "55%", height: "38%", left: "3%",  top: "8%",  background: "radial-gradient(ellipse, hsl(190 70% 72% / 0.09) 0%, transparent 68%)" }} />
      <div className="water-caustic-b pointer-events-none absolute" style={{ width: "48%", height: "32%", right: "2%", top: "22%", background: "radial-gradient(ellipse, hsl(205 60% 78% / 0.07) 0%, transparent 68%)" }} />
      <div className="water-caustic-c pointer-events-none absolute" style={{ width: "52%", height: "35%", left: "22%", bottom: "8%", background: "radial-gradient(ellipse, hsl(185 55% 80% / 0.06) 0%, transparent 68%)" }} />
      <header className="relative mx-auto flex h-[52px] max-w-6xl items-center justify-between px-5 md:px-8">
        <div />
      </header>

      <div className="relative mx-auto flex max-w-6xl flex-col items-center px-5 pb-6 pt-3 text-center">

        {/* Hero title */}
        <div className="animate-rise">
          <h1 className="mx-auto max-w-2xl tracking-[-0.04em] text-sidebar">
            <span className="block text-[2.6rem] font-semibold leading-[1.05] md:text-5xl">PDF Markup</span>
            <span className="block text-[1.6rem] font-medium leading-snug text-primary md:text-[2rem]">&amp; Area Estimation Tool</span>
          </h1>
        </div>

        {/* Drop zone */}
        <div
          className={`relative mt-3 w-full max-w-[680px] rounded-2xl border border-dashed p-1.5 transition ${isDragging ? "border-primary bg-primary/10" : "border-primary/35 bg-card/75"}`}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => { e.preventDefault(); setIsDragging(false); onFileChange({ target: { files: e.dataTransfer.files } } as unknown as ChangeEvent<HTMLInputElement>); }}
        >
          <div className="rounded-xl border border-border bg-card px-6 py-5 shadow-[0_18px_50px_rgba(42,83,112,.10)] md:px-10 md:py-7">
            {isLoading
              ? (<><div className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-secondary"><Cloud className="animate-pulse text-primary" size={23} /></div><h2 className="mt-3 text-base font-semibold">Opening your plan…</h2><p className="mt-1.5 text-sm text-muted-foreground">Preparing a private workspace in your browser.</p><button type="button" className="button-primary mt-4 cursor-wait opacity-80" disabled aria-busy="true"><span className="size-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true" /> Loading…</button></>)
              : (<><div className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Upload size={23} /></div><h2 className="mt-3 text-base font-semibold text-sidebar">Drop a PDF plan here</h2><p className="mt-1.5 text-sm text-muted-foreground">or choose a file from your device · PDF only</p><button type="button" onClick={onOpen} className="button-primary mt-4"><FilePlus2 size={16} /> Choose PDF</button></>)}
          </div>
        </div>
        {error && <div className="mt-3 flex max-w-md items-center gap-2 rounded-lg border border-destructive/25 bg-destructive/10 px-4 py-3 text-left text-xs text-destructive" role="alert"><CircleHelp size={16} className="shrink-0" />{error}</div>}

        {/* Feature chips */}
        <div className="mt-4 grid w-full max-w-2xl grid-cols-1 gap-2 text-left sm:grid-cols-3">
          <Feature icon={<Ruler size={16} />}         title="Tools"            body="Scale-aware measurements — Line, Dimension, and Area. Outline areas with exact length and ruler-straight lines using Shift or Ctrl." />
          <Feature icon={<ClipboardList size={16} />} title="Schedule / Takeoff" body="Turn markups into quantities. Double-check, make manual entries if needed, and export schedules." />
          <ScreenPreview src={`${import.meta.env.BASE_URL}preview-area.png`}  caption="Area takeoff on elevations" />
        </div>

        {/* Screenshot previews */}
        <div className="mt-2.5 grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-3">
          <ScreenPreview src={`${import.meta.env.BASE_URL}preview-line.png`}  caption="Line tool on a roof plan" />
          <ScreenPreview src={`${import.meta.env.BASE_URL}preview-site.png`}  caption="Auto-detected scale on a site plan" />
          <a href="https://bluejetty.ca/" target="_blank" rel="noopener noreferrer" className="group overflow-hidden rounded-xl border border-border/70 bg-card/60 shadow-sm transition hover:border-primary/40 hover:shadow-md">
            <div className="flex w-full items-center justify-center bg-white" style={{ aspectRatio: "16/10" }}>
              <img src={`${import.meta.env.BASE_URL}bluejetty-logo.png`} alt="Blue Jetty Home Design" className="h-full w-full object-contain" />
            </div>
            <p className="px-3 py-2 text-[11px] text-muted-foreground group-hover:text-primary transition-colors">bluejetty.ca</p>
          </a>
        </div>

      </div>
      <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={onFileChange} />
    </div>
  );
}

type CatRow = { id: string; label: string; color: string; areas: { id: string; page: number; sqFt?: number; adjustedSqFt?: number; slopePitch?: string }[]; total: number };
function ScheduleRow({ cat }: { cat: CatRow }) {
  return (
    <div>
      <div className="flex items-center justify-between rounded-lg px-3 py-2" style={{ backgroundColor: cat.color + "18" }}>
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ backgroundColor: cat.color }} />
          <span className="text-sm font-bold" style={{ color: cat.color }}>{cat.label}</span>
          <span className="text-xs text-muted-foreground">({cat.areas.length} {cat.areas.length === 1 ? "area" : "areas"})</span>
        </div>
        <span className="font-mono text-sm font-bold" style={{ color: cat.color }}>{Math.round(cat.total).toLocaleString()} sq ft</span>
      </div>
      <div className="mt-1 space-y-0.5 px-3">
        {cat.areas.map((a, i) => (
          <div key={a.id} className="text-xs text-muted-foreground">
            {a.adjustedSqFt && a.slopePitch ? (
              <div className="flex items-center justify-between">
                <span>Page {a.page}, area {i + 1}</span>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-muted-foreground/60">{Math.round(a.sqFt ?? 0).toLocaleString()} flat</span>
                  <span className="text-muted-foreground/40">→</span>
                  <span className="font-mono font-semibold text-sidebar">{Math.round(a.adjustedSqFt).toLocaleString()} sq ft</span>
                  <span className="rounded bg-muted px-1 py-0.5 text-[9px] font-medium text-muted-foreground">@ {a.slopePitch}</span>
                </span>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <span>Page {a.page}, area {i + 1}</span>
                <span className="font-mono">{Math.round(a.sqFt ?? 0).toLocaleString()} sq ft</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return <div className="rounded-xl border border-border/70 bg-card/60 p-4"><div className="flex items-center gap-2 text-primary">{icon}<span className="text-sm font-semibold text-sidebar">{title}</span></div><p className="mt-1.5 pl-6 text-xs leading-relaxed text-muted-foreground">{body}</p></div>;
}

function ScreenPreview({ src, caption }: { src: string; caption: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card/60 shadow-sm">
      <img src={src} alt={caption} className="w-full object-cover object-top" style={{ aspectRatio: "16/10" }} />
      <p className="px-3 py-2 text-[11px] text-muted-foreground">{caption}</p>
    </div>
  );
}

// ─── Export dialog ────────────────────────────────────────────────────────────
function ExportDialog({ exportType, setExportType, exportRange, setExportRange, dpi, setDpi, onClose, onExport, documentName, page }: { exportType: "vector" | "flattened"; setExportType: (v: "vector" | "flattened") => void; exportRange: "all" | "selected"; setExportRange: (v: "all" | "selected") => void; dpi: "150" | "300"; setDpi: (v: "150" | "300") => void; onClose: () => void; onExport: () => void; documentName: string; page: number }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-sidebar/35 p-3 backdrop-blur-[2px] sm:items-center" role="dialog" aria-modal="true">
      <div className="w-full max-w-[510px] rounded-2xl border border-border bg-card p-5 shadow-2xl animate-rise sm:p-6">
        <div className="flex items-start justify-between">
          <div><p className="eyebrow text-primary">Send a field copy</p><h2 className="mt-2 text-xl font-semibold tracking-tight text-sidebar">Export markup</h2><p className="mt-1 truncate text-xs text-muted-foreground">{documentName}</p></div>
          <button className="toolbar-button" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </div>
        <div className="mt-6 space-y-5">
          <fieldset><legend className="mb-2 text-xs font-semibold text-sidebar">Output</legend><div className="grid grid-cols-2 gap-2"><Choice active={exportType === "vector"} onClick={() => setExportType("vector")} title="Marked-up PDF" body="Markup burned into PDF" /><Choice active={exportType === "flattened"} onClick={() => setExportType("flattened")} title="Flattened PNG" body="Current page as image" /></div></fieldset>
          <fieldset><legend className="mb-2 text-xs font-semibold text-sidebar">Pages</legend><div className="grid grid-cols-2 gap-2"><Choice active={exportRange === "all"} onClick={() => setExportRange("all")} title="Full PDF" body="All plan sheets" /><Choice active={exportRange === "selected"} onClick={() => setExportRange("selected")} title={`Page ${page}`} body="Current sheet only" /></div></fieldset>
          <fieldset><legend className="mb-2 text-xs font-semibold text-sidebar">Flattened resolution</legend><div className="flex gap-2">{(["150", "300"] as const).map((v) => (<button key={v} onClick={() => setDpi(v)} className={`flex-1 rounded-lg border px-3 py-2.5 text-left transition ${dpi === v ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"}`} aria-pressed={dpi === v}><span className="block font-mono text-sm font-bold">{v} <span className="text-[10px] font-normal">DPI</span></span><span className="mt-0.5 block text-[10px]">{v === "150" ? "Screen & email" : "Print-ready"}</span></button>))}</div></fieldset>
        </div>
        <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><ShieldCheck size={14} className="text-primary" /> Export happens locally</span>
          <button className="button-primary" onClick={onExport}><Download size={16} /> Export now</button>
        </div>
      </div>
    </div>
  );
}

function Choice({ active, onClick, title, body }: { active: boolean; onClick: () => void; title: string; body: string }) {
  return <button onClick={onClick} className={`rounded-lg border px-3 py-3 text-left transition ${active ? "border-primary bg-primary/10" : "border-border hover:border-primary/40"}`} aria-pressed={active}><span className="flex items-center justify-between text-xs font-semibold text-sidebar">{title}{active && <Check size={14} className="text-primary" />}</span><span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground">{body}</span></button>;
}
