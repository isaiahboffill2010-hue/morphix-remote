import { describe, expect, it } from "vitest";
import { slowFirstLayers } from "@morphix/slicing";
import { PRUSA_GCODE } from "./phase3-fixtures";

const layerOf = (g: string) => {
  const out: { layer: number; line: string }[] = [];
  let layer = -1;
  for (const line of g.split("\n")) {
    if (line.startsWith(";LAYER_CHANGE")) layer++;
    out.push({ layer, line });
  }
  return out;
};

describe("slowFirstLayers", () => {
  it("halves every feed rate in the first N layers and leaves the rest alone", () => {
    const g = slowFirstLayers(PRUSA_GCODE, 2, 0.5);
    const lines = layerOf(g);
    expect(lines.find((l) => l.layer === 0 && l.line.startsWith("G1 X100 Y100"))?.line).toBe("G1 X100 Y100 F3600");
    expect(lines.find((l) => l.layer === 0 && l.line.includes("E1.0"))?.line).toBe("G1 X120 Y100 E1.0 F900");
    expect(lines.find((l) => l.layer === 1 && l.line.includes("E5.0"))?.line).toBe("G1 X120 Y100 E5.0 F900");
    // layer 2 (the third) is back to the sliced speed, and the modal F is restored first
    expect(lines.find((l) => l.layer === 2 && l.line.includes("E9.0"))?.line).toBe("G1 X120 Y100 E9.0 F1800");
    expect(lines.find((l) => l.layer === 2 && l.line.includes("back to normal speed"))?.line).toBe("G1 F1800 ; Morphix: back to normal speed");
  });

  it("does not touch the start G-code before the first layer", () => {
    const g = slowFirstLayers(PRUSA_GCODE, 5, 0.5);
    const before = PRUSA_GCODE.slice(0, PRUSA_GCODE.indexOf(";LAYER_CHANGE"));
    expect(g.startsWith(before)).toBe(true);
  });

  it("is a no-op when disabled or when there are no layer markers", () => {
    expect(slowFirstLayers(PRUSA_GCODE, 0)).toBe(PRUSA_GCODE);
    expect(slowFirstLayers(PRUSA_GCODE, 5, 1)).toBe(PRUSA_GCODE);
    const plain = "G28\nG1 X10 F3000\n";
    expect(slowFirstLayers(plain)).toBe(plain);
  });
});
