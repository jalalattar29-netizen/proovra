import React from "react";

const makeSvgElement = (name) => ({ children, ...props }) =>
  React.createElement(name, props, children);

const Svg = makeSvgElement("Svg");
const Path = makeSvgElement("Path");

export default Svg;
export { Svg, Path };
