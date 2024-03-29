import { test, expect } from "vitest";
import "@pkg/index";
import { BlockyDocument, BlockElement } from "blocky-data";
import { TextBlock } from "@pkg/block/textBlock";

test("block level 0", () => {
  const root = new BlockyDocument();
  const firstElement = new BlockElement(TextBlock.Name, "id-1");
  root.__insertChildAt(root.childrenLength, firstElement);
  expect(firstElement.blockLevel()).toBe(0);
});

test("block level 1", () => {
  const root = new BlockyDocument();
  const firstElement = new BlockElement(TextBlock.Name, "id-1");
  root.__insertChildAt(root.childrenLength, firstElement);
  const childElement = new BlockElement(TextBlock.Name, "id-2");
  firstElement.__insertChildAt(firstElement.childrenLength, childElement);
  expect(childElement.blockLevel()).toBe(1);
});
