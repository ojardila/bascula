/**
 * The ONLY module that imports react-joyride. TourHost loads it with
 * React.lazy when a spotlight step has to be drawn, so a person who never
 * sees a tour never downloads the library.
 *
 * Controlled, one step at a time: our own TourContext owns the order (some
 * steps are inline callouts Joyride never sees), and Joyride does what it is
 * good at — the spotlight, scrolling to the element, and placing the globe
 * where it fits on a phone or a desk.
 */
import { Joyride, EVENTS, type EventData, type TooltipRenderProps } from "react-joyride";
import { TourCard } from "./TourCard";
import type { TourName, TourStepDef } from "./steps";

function Tooltip(props: TooltipRenderProps) {
  const { tour, def } = props.step.data as { tour: TourName; def: TourStepDef };
  return (
    <div {...props.tooltipProps}>
      <TourCard tour={tour} def={def} />
    </div>
  );
}

export default function JoyrideTour({
  tour,
  def,
  onMissing,
}: {
  tour: TourName;
  def: TourStepDef;
  onMissing: () => void;
}) {
  return (
    <Joyride
      key={`${tour}-${def.n}`}
      run
      stepIndex={0}
      continuous
      steps={[
        {
          target: def.target ?? "body",
          content: def.title,
          placement: def.placement ?? "auto",
          data: { tour, def },
        },
      ]}
      tooltipComponent={Tooltip}
      options={{
        // Above the app bar (1201), below MUI dialogs (1300).
        zIndex: 1250,
        overlayColor: "rgba(20, 24, 20, 0.58)",
        skipBeacon: true,
        disableFocusTrap: true,
        overlayClickAction: false,
        dismissKeyAction: false,
        spotlightRadius: 18,
        spotlightPadding: 8,
        targetWaitTimeout: 8000,
        scrollOffset: 96,
        arrowColor: "#ffffff",
        width: "min(440px, calc(100vw - 24px))",
      }}
      styles={{
        spotlight: { stroke: "#F2C94C", strokeWidth: 4 },
      }}
      onEvent={(data: EventData) => {
        if (data.type === EVENTS.TARGET_NOT_FOUND) onMissing();
      }}
    />
  );
}
