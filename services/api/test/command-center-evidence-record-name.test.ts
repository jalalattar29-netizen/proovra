import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import { evidenceRecordName } from "../src/services/dashboard/evidence-record-name.js";

describe("evidenceRecordName", () => {
  it("prefers a real title", () => {
    assert.equal(
      evidenceRecordName({ title: " Dock photo ", displayFileName: "a.jpg", originalFileName: "b.jpg" }),
      "Dock photo",
    );
  });

  it("reads the file names when the title is missing, blank or generated", () => {
    assert.equal(evidenceRecordName({ title: null, displayFileName: "a.jpg" }), "a.jpg");
    assert.equal(evidenceRecordName({ title: "  ", displayFileName: " ", originalFileName: "b.jpg" }), "b.jpg");
    assert.equal(evidenceRecordName({ title: "Digital Evidence Record", originalFileName: "b.jpg" }), "b.jpg");
  });

  it("invents nothing for a record with no name", () => {
    assert.equal(evidenceRecordName({ title: null, displayFileName: null, originalFileName: "" }), null);
  });

  it("every command-center evidence row reads the file names", () => {
    const source = readFileSync(
      new URL("../src/services/dashboard/command-center.service.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /\.title \?\? "Untitled evidence"/);
    assert.equal(source.match(/evidenceRecordName\(\w+\) \?\? "Untitled evidence"/g)?.length, 9);
    assert.equal(source.match(/originalFileName: true/g)!.length >= 9, true);
  });
});
