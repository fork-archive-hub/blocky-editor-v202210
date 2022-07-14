import { test, expect } from "vitest";
import {
  TextBlockName,
  BlockyElement,
  BlockElement,
  DocNodeName,
} from "@pkg/index";

test("block level 0", () => {
  const root = new BlockyElement(DocNodeName);
  const firstElement = new BlockElement(TextBlockName, "id-1");
  root.appendChild(firstElement);
  expect(firstElement.blockLevel()).toBe(0);
});

test("block level 1", () => {
  const root = new BlockyElement(DocNodeName);
  const firstElement = new BlockElement(TextBlockName, "id-1");
  root.appendChild(firstElement);
  const deepElement = new BlockElement(TextBlockName, "id-2");
  const childrenContainer = new BlockyElement("block-children");
  firstElement.appendChild(childrenContainer);
  childrenContainer.appendChild(deepElement);
  expect(deepElement.blockLevel()).toBe(1);
});