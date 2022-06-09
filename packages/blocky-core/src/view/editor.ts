import { $on } from "blocky-common/es/dom";
import { observe, runInAction } from "blocky-common/es/observable";
import { Slot } from "blocky-common/es/events";
import { type IDisposable, flattenDisposable } from "blocky-common/es/disposable";
import { lazy } from "blocky-common/es/lazy";
import { docRenderer } from "view/renderer";
import {
  State as DocumentState,
  type TreeNode,
  type DocNode,
  type Span,
} from "model/index";
import { type CursorState } from "model/cursor";
import { Action } from "model/actions";
import { PluginRegistry, type AfterFn } from "registry/pluginRegistry";
import { SpanRegistry } from "registry/spanRegistry";
import { BlockRegistry } from "registry/blockRegistry";
import { type IdGenerator, makeDefaultIdGenerator } from "helper/idHelper";
import fastdiff from "fast-diff";

const arrowKeys = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

function removeNodesAfter(node: TreeNode<DocNode>, actions: Action[]) {
  let ptr = node.next;
  while (ptr) {
    actions.push({
      type: "delete",
      targetId: ptr.data.id,
    });
    ptr = ptr.next;
  }
}

function areEqualShallow(a: any, b: any) {
  if (typeof a === "object" && typeof b === "object") {
    for (let key in a) {
      if (!(key in b) || a[key] !== b[key]) {
        return false;
      }
    }
    for (let key in b) {
      if (!(key in a)) {
        return false;
      }
    }
    return true;
  } else {
    return a === b;
  }
}

export interface EditorRegistry {
  span: SpanRegistry;
  plugin: PluginRegistry;
  block: BlockRegistry;
}

export interface IEditorOptions {
  state: DocumentState,
  registry: EditorRegistry,
  container: HTMLDivElement,
  idGenerator?: IdGenerator,
}

export class Editor {
  #container: HTMLDivElement;
  #renderedDom: HTMLDivElement | undefined;
  #idGen: IdGenerator;

  public readonly state: DocumentState;
  public readonly registry: EditorRegistry;
  public readonly keyUp = new Slot<KeyboardEvent>();
  public readonly keyDown = new Slot<KeyboardEvent>();

  public composing: boolean = false;
  private disposables: IDisposable[] = [];

  constructor(options: IEditorOptions) {
    const { container, state, registry, idGenerator } = options;
    this.state = state;
    this.registry = registry;
    this.#container = container;
    this.#idGen = idGenerator ?? makeDefaultIdGenerator();

    container.contentEditable = "true";

    $on(container, "input", (e: Event) => {
      if (this.composing) {
        return;
      }
      this.handleContentChanged(e);
    });
    $on(container, "compositionstart", this.handleCompositionStart);
    $on(container, "compositionend", this.handleCompositionEnd);
    $on(container, "keydown", this.handleKeyDown);
    $on(container, "paste", this.handlePaste);

    document.addEventListener("selectionchange", this.selectionChanged);

    this.disposables.push(
      observe(state, "cursorState", this.handleCursorStateChanged),
    );

    this.registry.plugin.emitInitPlugins(this);
  }

  render(done?: AfterFn) {
    const newDom = docRenderer({
      clsPrefix: "blocky",
      editor: this,
      oldDom: this.#renderedDom,
      registry: this.registry,
    });
    if (!this.#renderedDom) {
      this.#container.appendChild(newDom);
    }
    this.#renderedDom = newDom;

    if (done) {
      done();
    } else {
      this.selectionChanged();
    }
  }

  private getTreeNodeFromDom(node: Node): TreeNode<DocNode> | undefined {
    if (node._mgNode) {
      return node._mgNode;
    }

    if (node instanceof Text && node.parentNode instanceof HTMLSpanElement) {
      const parent = node.parentNode;
      if (parent._mgNode) {
        return parent._mgNode;
      }
    }
  }

  private selectionChanged = () => {
    const sel = window.getSelection();
    if (!sel) {
      return;
    }

    if (sel.rangeCount === 0) {
      return;
    }

    const range = sel.getRangeAt(0);
    const { startContainer, endContainer, startOffset, endOffset } = range;

    const startNode = this.getTreeNodeFromDom(startContainer);
    if (!startNode) {
      return;
    }

    if (range.collapsed) {
      this.state.cursorState = {
        type: "collapsed",
        targetId: startNode.data.id,
        offset: startOffset,
      };
    } else {
      const endNode = this.getTreeNodeFromDom(endContainer);
      if (!endNode) {
        return;
      }
      this.state.cursorState = {
        type: "open",
        startId: startNode.data.id,
        startOffset: startOffset,
        endId: endNode.data.id,
        endOffset,
      };
    }
    console.log("selection:", this.state.cursorState);
  };

  private checkMarkedDom(
    node: Node,
    actions: Action[],
    currentOffset?: number,
  ) {
    const treeNode = node._mgNode as TreeNode<DocNode>;
    if (!node.parentNode) {
      // dom has been removed
      actions.push({
        type: "delete",
        targetId: treeNode.data.id,
      });
      return;
    }

    const { data } = treeNode;
    if (data.t === "span") {
      const { content, id } = data;
      const currentContent = node.textContent || "";
      if (content !== currentContent) {
        actions.push({
          type: "update-span",
          targetId: id,
          value: { content: currentContent },
          get diffs() {
            return lazy(() => {
              return fastdiff(content, currentContent, currentOffset);
            })();
          },
        });
      }
    } else if (data.t === "block") {
      // check if there is new span created by the browser
      this.checkLineContent(node, treeNode, actions);
    }
  }

  private checkLineContent(
    node: Node,
    lineNode: TreeNode<DocNode>,
    actions: Action[],
  ) {
    const contentContainer = node.firstChild! as HTMLElement;

    let prevId: string | undefined;

    let ptr = contentContainer.firstChild;

    const nodesToRemoved: Node[] = [];

    while (ptr) {
      if (ptr instanceof Text) {
        if (ptr._mgNode) {
          const node = ptr._mgNode as TreeNode<DocNode>;
          prevId = node.data.id;
        } else {
          // add a new node
          const newId = this.#idGen.mkSpanId();
          actions.push({
            type: "new-span",
            targetId: lineNode.data.id,
            afterId: prevId,
            content: {
              id: newId,
              t: "span",
              flags: 0,
              content: ptr.textContent || "",
            },
          });
          prevId = newId;
          nodesToRemoved.push(ptr);
        }
      } else if (ptr instanceof HTMLSpanElement) {
        if (ptr._mgNode) {
          const node = ptr._mgNode as TreeNode<DocNode>;
          prevId = node.data.id;
        } else {
          // add a new node
          const newId = this.#idGen.mkSpanId();
          const dataType = parseInt(ptr.getAttribute("data-type") || "0", 0);
          actions.push({
            type: "new-span",
            targetId: lineNode.data.id,
            afterId: prevId,
            content: {
              id: newId,
              t: "span",
              flags: dataType,
              content: ptr.textContent || "",
            },
          });
          prevId = newId;
          nodesToRemoved.push(ptr);
        }
      } else {
        nodesToRemoved.push(ptr);
      }

      ptr = ptr.nextSibling;
    }

    nodesToRemoved.forEach((node) => node.parentNode?.removeChild(node));
  }

  private checkNodesChanged(actions: Action[]) {
    const doms = this.state.domMap.values();
    for (const dom of doms) {
      this.checkMarkedDom(dom, actions);
    }
  }

  private handleOpenCursorContentChanged() {
    const actions: Action[] = [];
    this.checkNodesChanged(actions);
    this.applyActions(actions);
  }

  private handleContentChanged = (e?: any) => {
    const { cursorState } = this.state;
    if (cursorState === undefined || cursorState.type === "open") {
      this.handleOpenCursorContentChanged();
      return;
    }

    const { targetId: spanId, offset: currentOffset } = cursorState;

    const domNode = this.state.domMap.get(spanId);
    if (!domNode) {
      return;
    }

    const actions: Action[] = [];

    this.checkMarkedDom(domNode, actions, currentOffset);
    this.applyActions(actions);
  };

  public applyActions(actions: Action[], noUpdate: boolean = false) {
    if (actions.length === 0) {
      return;
    }

    console.log("apply:", actions);
    let afterFn: AfterFn | undefined;
    runInAction(this.state, () => {
      afterFn = this.registry.plugin.emitBeforeApply(this, actions);
      this.state.applyActions(actions);
    });
    if (noUpdate) {
      if (afterFn) {
        afterFn();
      } else if (actions.length > 0) {
        this.selectionChanged();
      }
    } else {
      this.render(() => {
        if (afterFn) {
          afterFn();
        } else if (actions.length > 0) {
          this.selectionChanged();
        }
      });
    }
  }

  public placeBannerAt() {

  }

  public hideBanner() {

  }

  private handleCompositionStart = (e: CompositionEvent) => {
    this.composing = true;
  };

  private handleCompositionEnd = (e: CompositionEvent) => {
    this.composing = false;
    this.handleContentChanged();
  };

  private handleKeyDown = (e: KeyboardEvent) => {
    this.keyDown.emit(e);
    if (e.defaultPrevented) {
      return;
    }

    if (e.key === "Tab") {
      this.handleKeyTab(e);
      return;
    }

    if (arrowKeys.has(e.key)) {
      return;
    }

    if (this.composing) {
      return;
    }

    if (e.key === "Enter") {
      if (!e.defaultPrevented) {
        e.preventDefault();
        this.commitNewLine();
      }
    } else if (e.key === "Backspace") {
      this.handleBackspace(e);
    } else if (e.key === "ArrowUp") {
      this.keyUp.emit(e);
    } else if (e.key === "ArrowDown") {
      this.keyDown.emit(e);
    } else if (e.key === "Delete") {
      this.handleDelete(e);
    }
  };

  private handleKeyTab(e: KeyboardEvent) {
    e.preventDefault();
  }

  private sliceSpanNode(spanNode: TreeNode<DocNode>, offset: number): Span[] {
    const result: Span[] = [];

    let ptr: TreeNode<DocNode> | undefined = spanNode;

    while (ptr) {
      if (ptr.data.t === "span") {
        result.push({
          ...ptr.data,
          id: this.#idGen.mkSpanId(),
        });
      }
      ptr = ptr.next;
    }

    if (result.length > 0) {
      result[0].content = result[0].content.slice(offset);
    }

    return result;
  }

  private commitNewLine() {
    const { cursorState } = this.state;
    if (!cursorState) {
      return;
    }
    if (cursorState.type === "collapsed") {
      const node = this.state.idMap.get(cursorState.targetId);
      if (!node) {
        return;
      }

      const { data } = node;
      if (data.t !== "span") {
        return;
      }

      const lineNode = node.parent?.parent;
      if (!lineNode) {
        return;
      }

      const parnetNode = lineNode.parent;
      if (!parnetNode) {
        return;
      }

      const cursorOffset = cursorState.offset;
      const remain: Span[] = this.sliceSpanNode(node, cursorOffset);

      const actions: Action[] = [
        {
          type: "new-block",
          targetId: parnetNode.data.id,
          newId: this.#idGen.mkBlockId(),
          afterId: lineNode.data.id,
          spans: remain,
        },
      ];

      if (cursorOffset < data.content.length) {
        const before = data.content.slice(0, cursorOffset);
        actions.push({
          type: "update-span",
          targetId: node.data.id,
          value: {
            content: before,
          },
        });
      }

      removeNodesAfter(node, actions);
      this.applyActions(actions);
      this.render(() => {
        if (remain.length > 0) {
          const firstSpan = remain[0];
          this.state.cursorState = {
            type: "collapsed",
            targetId: firstSpan.id,
            offset: 0,
          };
        }
      });
    } else {
      console.error("unhandled");
    }
  }

  private handleDelete(e: KeyboardEvent) {
    e.preventDefault();
  }

  private handleBackspace(e: KeyboardEvent) {
    const { cursorState } = this.state;
    if (!cursorState) {
      return;
    }
    if (cursorState.type === "open") {
      return;
    }
    const { targetId, offset } = cursorState;
    const node = this.state.idMap.get(targetId);
    if (!node) {
      return;
    }
    const { data } = node;
    if (data.t !== "span") {
      return;
    }
    if (offset === 0) {
      // at the beginning of a line
      e.preventDefault();
      this.tryBackDeleteThisLine(node);
      return;
    }
  }

  // private normalizeLine(lineNode: TreeNode<DocNode>) {
  //   const actions: Action[] = [];
  //   normalizeLine(lineNode, actions);
  //   console.log("normalize action", actions);
  //   this.applyActions(actions);
  // }

  // return the first id of new spans
  private pushingSpansToPreviousLine(
    spanNode: TreeNode<DocNode>,
    prevLineNode: TreeNode<DocNode>,
    actions: Action[],
  ): string | undefined {
    const lineId = prevLineNode.data.id;
    const lastNodeOfPrevLine = prevLineNode.firstChild!.lastChild as
      | TreeNode<Span>
      | undefined;

    let afterId = lastNodeOfPrevLine?.data.id;

    let ptr = spanNode as TreeNode<Span> | undefined;

    // merge the first one if the flags are equal
    if (
      lastNodeOfPrevLine &&
      ptr &&
      ptr.data.flags === lastNodeOfPrevLine.data.flags
    ) {
      const content = lastNodeOfPrevLine.data.content + ptr.data.content;
      actions.push({
        type: "update-span",
        targetId: lastNodeOfPrevLine.data.id,
        value: { content },
      });
      ptr = ptr.next;
    }

    let firstId: string | undefined;
    while (ptr) {
      const currentSpan = ptr.data as Span;
      if (currentSpan.content.length > 0) {
        const newId = this.#idGen.mkSpanId();
        if (!firstId) {
          firstId = newId;
        }
        actions.push({
          type: "new-span",
          targetId: lineId,
          afterId,
          content: {
            t: "span",
            id: newId,
            content: currentSpan.content,
            flags: currentSpan.flags,
          },
        });
        afterId = newId;
      }

      ptr = ptr.next;
    }

    return firstId;
  }

  private tryDeleteLineOfSpan(spanNode: TreeNode<DocNode>) {
    const lineNode = spanNode.parent!.parent!;

    const prevLineNode = lineNode.prev;
    if (!prevLineNode) {
      // it's the first line
      return;
    }

    const lineId = lineNode.data.id;

    const actions: Action[] = [
      {
        type: "delete",
        targetId: lineId,
      },
    ];

    // TODO: handle offset
    const firstId = this.pushingSpansToPreviousLine(
      spanNode,
      prevLineNode,
      actions,
    );

    this.applyActions(actions);

    this.render(() => {
      if (firstId) {
        this.state.cursorState = {
          type: "collapsed",
          targetId: firstId,
          offset: 0,
        };
      } else {
        const lastSpan = prevLineNode.firstChild?.lastChild;
        if (!lastSpan) {
          this.state.cursorState = undefined;
          return;
        }

        const lastSpanData = lastSpan.data as Span;
        this.state.cursorState = {
          type: "collapsed",
          targetId: lastSpanData.id,
          offset: lastSpanData.content.length,
        };
      }
    });
  }

  private tryBackDeleteThisLine(spanNode: TreeNode<DocNode>) {
    if (spanNode.data.t !== "span") {
      return;
    }

    const { prev } = spanNode;
    if (!prev) {
      this.tryDeleteLineOfSpan(spanNode);
      return;
    }
  }

  private handleCursorStateChanged = (
    newState: CursorState | undefined,
    oldState: CursorState | undefined,
  ) => {
    if (areEqualShallow(newState, oldState)) {
      return;
    }

    console.log("new cursor state: ", newState, oldState);

    const sel = window.getSelection();
    if (!sel) {
      return;
    }

    if (!newState) {
      sel.removeAllRanges();
      return;
    }

    if (newState.type === "open") {
      return;
    }

    const { targetId, offset } = newState;

    const targetNode = this.state.domMap.get(targetId);
    if (!targetNode) {
      throw new Error(`dom not found: ${targetId}`);
    }

    sel.removeAllRanges();

    const range = document.createRange();
    if (targetNode instanceof Text) {
      range.setStart(targetNode, offset);
      range.setEnd(targetNode, offset);
      sel.addRange(range);
    } else if (targetNode instanceof HTMLSpanElement) {
      let child = targetNode.firstChild;
      if (!child) {
        child = document.createTextNode("");
        targetNode.appendChild(child);
      }
      range.setStart(child, offset);
      range.setEnd(child, offset);
      sel.addRange(range);
    } else {
      console.error("unknown element:", targetNode);
    }
  };

  private handlePaste = (e: ClipboardEvent) => {
    e.preventDefault();
  };

  dispose() {
    document.removeEventListener("selectionchange", this.selectionChanged);
    flattenDisposable(this.disposables).dispose();
  }
}
