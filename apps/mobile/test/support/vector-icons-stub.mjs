/**
 * `@expo/vector-icons/Feather` stub (T-09f).
 *
 * The real module ships a .ttf and registers it through expo-font, neither of
 * which loads under Node. This renders a host element named "Icon" carrying the
 * SAME `name` prop, so a render test can assert WHICH glyph a destination wears
 * rather than only that "an icon" exists.
 */
import React from "react";

const Feather = ({ name, size, color, ...props }) =>
  React.createElement("Icon", { ...props, name, size, color, family: "Feather" });
Feather.displayName = "Feather";
/** Identity is all the font map needs; the value is opaque in production. */
Feather.font = { feather: "feather.ttf" };

export default Feather;
export { Feather };
