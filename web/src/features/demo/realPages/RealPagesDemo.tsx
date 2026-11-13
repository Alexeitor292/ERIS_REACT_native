import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { ArrowRight, ChevronDown, ChevronUp, GripVertical, X } from "lucide-react";
import App from "../../../App";
import { UiSettingsProvider } from "../../../ui/UiSettingsContext";
import { mockDatabase, PEOPLE } from "./mockDatabase";
import "./realPagesDemo.css";

const TOUR = [
  { title: "Report an incident", actor: 0, path: "/incidents", text: "This is the actual ERIS Incidents page. Click Report an incident to open the real report form.", target: "Report an incident" },
  { title: "Locate the report", actor: 0, path: "/incidents", text: "Choose Coordinates, enter 38.450100 and -122.900100, then click Find its post mile. Typing alone does not confirm the location. Or use Fill the sample coordinates below to fill and confirm it for you.", target: "Find its post mile" },
  { title: "Describe the conditions", actor: 0, path: "/incidents", text: "Enter a description under What was seen and a date/time under First seen. You can attach sample evidence using the real Photos and files control. Then continue the guide.", target: "What was seen" },
  { title: "Send the field report", actor: 0, path: "/incidents", text: "Click Send report in the real form. The report enters the mock district review path. It has no permanent ERIS number yet.", target: "Send report" },
  { title: "Review the report in My Work", actor: 1, path: "/my-work?maintenance=1", text: "You are Morgan, the sample supervisor. Review the report and evidence. Select Complete review and continue, enter a review note, then Record action.", target: "Complete review and continue" },
  { title: "Make the district decision", actor: 2, path: "/my-work?maintenance=1", text: "Select Send to GeoTech. Choose Taylor as the District Contact, enter Demo storm event as the group name, add review notes, then Record action. This creates the incident record, group, and assessment.", target: "Send to GeoTech" },
  { title: "Route the assessment", actor: 3, path: "/my-work?assessment=1", text: "The actual My Work page now belongs to Jordan, the Office Chief. Choose Hand off to a branch chief, select Casey Nguyen as Branch chief, then Hand off.", target: "Hand off to a branch chief" },
  { title: "Assign Staff", actor: 4, path: "/my-work?assessment=1", text: "As Casey, select Sam Rivera in the Staff member picker and click Assign Staff member. ERIS creates the linked GISA draft.", target: "Select Staff member…" },
  { title: "Open the real GISA form", actor: 5, path: "/my-work?assessment=1", text: "As Sam, open Fill out submission #1. This opens the full production GISA page, with its real cards, maps, measurements, and memo editor.", target: "Fill out submission #1" },
  { title: "Prepare and save the draft", actor: 5, path: "/submissions/1", text: "Explore the actual GISA form. Add sample observations in the field notes or a memo, then click Save draft. All edits stay in this demo.", target: "Save draft" },
  { title: "Submit the assessment", actor: 5, path: "/my-work?assessment=1", text: "On the real My Work page, click Submit for review. Complete the confirmation dialog if it appears. Approval belongs to the assessment, not to a separate form button.", target: "Submit for review" },
  { title: "Request a revision", actor: 4, path: "/my-work?assessment=1", text: "As Casey, add a workflow note asking Sam to clarify the sample evidence limitations. Click Request revision.", target: "Request revision" },
  { title: "Revise the same technical form", actor: 5, path: "/submissions/1", text: "Update your sample observations or memo, then Save draft. You are editing the same GISA form. The prior review stays in the assessment history.", target: "Save draft" },
  { title: "Resubmit for review", actor: 5, path: "/my-work?assessment=1", text: "Return the revised assessment to Casey using Submit for review.", target: "Submit for review" },
  { title: "Approve the assessment", actor: 4, path: "/my-work?assessment=1", text: "Review the form and its history, then click Approve assessment. This completes the geotechnical assessment and generates the mock notice to Maintenance.", target: "Approve assessment" },
  { title: "Read the approved record", actor: 4, path: "/assessments/1", text: "As Casey, see the actual approved assessment record and its history. Maintenance receives the approved-record notice. Finish the demo to clear all mock records and files.", target: "Approved" },
] as const;

function navigate(path: string) {
  history.pushState(null, "", `/demo/world${path}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
export default function RealPagesDemo() {
  const version = useSyncExternalStore(mockDatabase.subscribe, mockDatabase.snapshot);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [index, setIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [ready, setReady] = useState(false);
  const [filling, setFilling] = useState(false);
  const [sampleProblem, setSampleProblem] = useState<string | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const guideRef = useRef<HTMLElement | null>(null);
  const drag = useRef<{ pointer: number; x: number; y: number; left: number; top: number } | null>(null);
  const current = TOUR[index];
  const startMutation = useRef(0);

  function clear(complete = false) { setRunning(false); setFinished(complete); mockDatabase.reset(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, "", "/demo/"); }
  function begin() { mockDatabase.reset(); localStorage.clear(); sessionStorage.clear(); setFinished(false); setIndex(0); setReady(false); setPosition(null); setCollapsed(false); setSampleProblem(null); mockDatabase.setActor(0); history.replaceState(null, "", "/demo/world/incidents"); setRunning(true); }
  function next() {
    if (index === TOUR.length - 1) { clear(true); return; }
    const nextIndex = index + 1;
    const step = TOUR[nextIndex];
    startMutation.current = mockDatabase.mutations.length;
    setReady(false); setIndex(nextIndex); mockDatabase.setActor(step.actor);
    // The location/description steps keep the unsent form mounted.
    if (nextIndex > 3) navigate(step.path);
  }
  function constrain(left: number, top: number) {
    const rect = guideRef.current?.getBoundingClientRect();
    return { left: Math.max(10, Math.min(left, window.innerWidth - (rect?.width ?? 350) - 10)), top: Math.max(10, Math.min(top, window.innerHeight - (rect?.height ?? 100) - 10)) };
  }
  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    const rect = guideRef.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const start = drag.current;
    if (start?.pointer === event.pointerId) setPosition(constrain(start.left + event.clientX - start.x, start.top + event.clientY - start.y));
  }
  function keyboardMove(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Home") { event.preventDefault(); setPosition(null); return; }
    const direction: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const delta = direction[event.key], rect = guideRef.current?.getBoundingClientRect();
    if (!delta || !rect) return;
    event.preventDefault(); const distance = event.shiftKey ? 50 : 20;
    setPosition(constrain(rect.left + delta[0] * distance, rect.top + delta[1] * distance));
  }
  async function fillSampleLocation() {
    setFilling(true); setSampleProblem(null);
    try {
      const scope = document.querySelector<HTMLElement>('[data-location-resolved]');
      const coordinates = [...(scope?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])].find((button) => button.textContent?.trim() === "Coordinates");
      if (!scope || !coordinates) throw new Error("Open Report an incident first, then try again.");
      flushSync(() => coordinates.click());
      for (const [label, value] of [["Latitude", "38.450100"], ["Longitude", "-122.900100"]]) {
        const input = [...scope.querySelectorAll("label")].find((element) => element.querySelector("span")?.textContent === label)?.querySelector("input");
        if (!input) throw new Error("The coordinate fields are unavailable. Reopen the report form and try again.");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
      }
      const find = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Find its post mile");
      if (!find || find.disabled) throw new Error("Wait for the location lookup to finish, then try again.");
      find.click();
    } catch (error) { setSampleProblem(error instanceof Error ? error.message : "The sample location could not be filled."); }
    finally { setFilling(false); }
  }
  useEffect(() => {
    if (!running || !position) return;
    const keepVisible = () => setPosition((previous) => previous ? constrain(previous.left, previous.top) : null);
    keepVisible(); window.addEventListener("resize", keepVisible);
    return () => window.removeEventListener("resize", keepVisible);
  }, [running, collapsed, index, ready, sampleProblem, position !== null]);
  // A visitor may send the report before advancing every introductory prompt.
  useEffect(() => { if (running && index < 3 && mockDatabase.incident) { setIndex(3); setReady(true); } }, [running, index, version]);
  useEffect(() => { const exit = () => clear(); window.addEventListener("eris-demo-exit", exit); return () => window.removeEventListener("eris-demo-exit", exit); }, []);
  useEffect(() => {
    if (!running) return;
    const changed = () => {
      const mutations = mockDatabase.mutations.slice(startMutation.current);
      const path = location.pathname;
      const readyNow = index === 0 ? !!document.getElementById("create-incident-title")
        : index === 1 ? !!document.querySelector('[data-location-resolved="true"]')
        : index === 2 ? !!Array.from(document.querySelectorAll("textarea")).find((el) => el.value.trim().length > 3) && !!document.querySelector<HTMLInputElement>('input[type="datetime-local"]')?.value
        : index === 3 ? !!mockDatabase.incident
        : index === 4 ? mockDatabase.maintenanceIndex === 1
        : index === 5 ? !!mockDatabase.assessment
        : index === 6 ? mockDatabase.assessment?.routing_path === "BRANCH"
        : index === 7 ? !!mockDatabase.submission
        : index === 8 ? /\/submissions\/1$/.test(path)
        : index === 9 || index === 12 ? mutations.some((m) => m.path.startsWith("/submissions/1/gisa"))
        : index === 10 || index === 13 ? mockDatabase.assessment?.state === "SUBMITTED"
        : index === 11 ? mockDatabase.assessment?.state === "REVISION_REQUESTED"
        : index === 14 ? mockDatabase.assessment?.state === "APPROVED" : true;
      setReady(readyNow);
    };
    const timer = window.setInterval(changed, 400); changed(); return () => window.clearInterval(timer);
  }, [running, index, version]);
  useEffect(() => {
    if (!running) return;
    const highlight = () => {
      document.querySelectorAll(".eris-demo-highlight").forEach((el) => el.classList.remove("eris-demo-highlight"));
      const target = index === 1 && ![...document.querySelectorAll("button")].some((el) => el.textContent?.trim() === current.target) ? "Coordinates" : current.target;
      const candidates = [...document.querySelectorAll("button,a,label")].filter((el) => !el.closest(".eris-demo-guide") && el.textContent?.trim() === target);
      const element = candidates.find((el) => (el as HTMLElement).offsetParent !== null);
      element?.classList.add("eris-demo-highlight");
    };
    const timer = window.setInterval(highlight, 600); highlight(); return () => { window.clearInterval(timer); document.querySelectorAll(".eris-demo-highlight").forEach((el) => el.classList.remove("eris-demo-highlight")); };
  }, [running, index, current.target]);
  useEffect(() => { document.title = running ? document.title : "ERIS | Guided web demo"; }, [running]);

  return running ? <>
    <UiSettingsProvider><App basename="/demo/world" key={current.actor} /></UiSettingsProvider>
    <aside ref={guideRef} className="eris-demo-guide" aria-label="Guided demo" style={position ? { left: position.left, top: position.top, right: "auto", bottom: "auto" } : undefined}>
      <div className="eris-demo-guide-bar">
        <button className="eris-demo-guide-handle" aria-label="Move walkthrough" title="Drag to move. Use arrow keys when focused; Home resets the position."
          onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={keyboardMove}>
          <GripVertical size={16} aria-hidden /><strong>Demo · {PEOPLE[current.actor].full_name}</strong>
        </button>
        <button onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "Expand guide" : "Minimize guide"}>{collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
        <button onClick={() => clear()} aria-label="Exit and clear demo"><X size={16} /></button>
      </div>
      {!collapsed ? <>
        <small>Step {index + 1} of {TOUR.length} · Actual ERIS web pages</small>
        <h2>{index === 3 && mockDatabase.incident ? "Report sent" : current.title}</h2>
        <p>{index === 3 && mockDatabase.incident ? "Your mock report was sent. Continue to review it as the sample supervisor." : current.text}</p>
        {index === 1 ? <>
          <button className="eris-demo-link" onClick={fillSampleLocation} disabled={filling}>{filling ? "Placing sample location…" : "Fill the sample coordinates"}</button>
          {sampleProblem ? <p role="alert">{sampleProblem}</p> : ready ? <p role="status">Location confirmed. Continue, then enter when it was first seen.</p> : null}
        </> : null}
        <div className="eris-demo-guide-actions">
          <button onClick={() => { const el = document.querySelector<HTMLElement>(".eris-demo-highlight"); el?.scrollIntoView({ block: "center", behavior: "smooth" }); el?.focus({ preventScroll: true }); }}>Show control</button>
          <button onClick={next} disabled={!ready} className="eris-demo-next">{index === TOUR.length - 1 ? "Finish & clear" : "Continue"}<ArrowRight size={14} /></button>
        </div>
        <p className="eris-demo-guide-note">All people and records are mock. Your ERIS sign-in grants access only. All scenario identities and records are mock.</p>
      </> : null}
    </aside>
  </> : <main className="eris-demo-intro"><img src="/demo/eris-logo.svg" alt="ERIS" /><p className="eris-demo-kicker">Guided web demo</p><h1>{finished ? "Demo complete. All mock data cleared." : "Internal ERIS training, with sample data"}</h1><p>Follow a field report through district Maintenance review, Office Chief routing, Staff assignment, the full GISA form, revision, and geotechnical approval.</p><p>This walkthrough uses the same page components, navigation, dialogs, and styles as the deployed web portal. Access requires ERIS sign-in. The data and scenario identities are mock. Each participant has an independent in-memory workspace.</p><button onClick={begin}><ArrowRight size={18} />{finished ? "Start a fresh demo" : "Start guided web demo"}</button><a href="/login">Return to ERIS</a><small>The native iOS walkthrough will be added separately. This demo covers the web portal.</small></main>;
}
