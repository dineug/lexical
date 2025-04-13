/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {$isHeadingNode, HeadingNode} from '@lexical/rich-text';
import {
  $isBlockElementNode,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isTabNode,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
  LineBreakNode,
  ParagraphNode,
  TabNode,
  TextNode,
} from 'lexical';

export type MarkdownConversion<T extends LexicalNode = LexicalNode> = {
  conversion: MarkdownConversionFn<T>;
  priority?: 0 | 1 | 2 | 3 | 4;
};

export type MarkdownConversionFn<T extends LexicalNode = LexicalNode> = (
  node: T,
  state: MarkdownConvertorState,
) => void;

export type MarkdownConversionMap<T extends LexicalNode = LexicalNode> = Record<
  NodeType,
  (node: T) => MarkdownConversion<T> | null
>;

type NodeType = string;

type InlineText = {
  text: string;
  formats: InlineFormat[];
};

type InlineFormat = {
  type: string;
  openTag: string;
  closeTag: string;
  htmlInline?: boolean;
};

export class MarkdownConvertorState {
  /** @internal */
  _delim: string;
  /** @internal */
  _result: string;
  /** @internal */
  _closed: false | LexicalNode;
  /** @internal */
  _stopNewline: boolean;
  /** @internal */
  _conversionCollection: Set<MarkdownConversionMap>;
  /** @internal */
  _inlineBuffer: InlineText[];

  constructor(conversionCollection: Set<MarkdownConversionMap>) {
    this._conversionCollection = conversionCollection;
    this._delim = '';
    this._result = '';
    this._closed = false;
    this._stopNewline = false;
    this._inlineBuffer = [];
  }

  /** @internal */
  private addOutput(output: string): void {
    this._result += output;
  }

  /** @internal */
  private isInBlank(): boolean {
    return /(^|\n)$/.test(this._result);
  }

  setDelim(delim: string): void {
    this._delim = delim;
  }

  getDelim(): string {
    return this._delim;
  }

  setStopNewline(stopNewline: boolean): void {
    this._stopNewline = stopNewline;
  }

  getStopNewline(): boolean {
    return this._stopNewline;
  }

  getClosed(): false | LexicalNode {
    return this._closed;
  }

  getResult(): string {
    return this._result;
  }

  ensureNewLine(): void {
    if (this.isInBlank()) {
      return;
    }

    this.addOutput('\n');
  }

  /**
   * @param size default 2
   * @example
   * flushClose(1) - "\n"
   * flushClose(2) - "\n" + "delim\n"
   * flushClose(3) - "\n" + "delim\n" + "delim\n"
   */
  flushClose(size: number = 2): void {
    if (this._stopNewline || !this._closed) {
      return;
    }

    if (!this.isInBlank()) {
      this.addOutput('\n');
    }

    if (size > 1) {
      let delimMin = this._delim;
      const trim = /\s+$/.exec(delimMin);

      if (trim) {
        delimMin = delimMin.slice(0, delimMin.length - trim[0].length);
      }

      for (let i = 1; i < size; i += 1) {
        this.addOutput(`${delimMin}\n`);
      }
    }

    this._closed = false;
  }

  write(content = ''): void {
    this.flushClose();

    if (this._delim && this.isInBlank()) {
      this.addOutput(this._delim);
    }

    if (content) {
      this.addOutput(content);
    }
  }

  text(text: string): void {
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      this.write();
      this.addOutput(lines[i]);

      if (i !== lines.length - 1) {
        this.addOutput('\n');
      }
    }
  }

  writeInline(inlineText: InlineText): void {
    this._inlineBuffer.push(inlineText);
  }

  flushInline(): void {
    const inlineBuffer = this._inlineBuffer;

    let result = '';
    let prevFormats: InlineFormat[] = [];

    const openTags = (formats: InlineFormat[]) =>
      formats.map((f) => f.openTag).join('');
    const closeTags = (formats: InlineFormat[]) =>
      formats
        .slice()
        .reverse()
        .map((f) => f.closeTag)
        .join('');

    for (let i = 0; i < inlineBuffer.length; i++) {
      const {text, formats} = inlineBuffer[i];

      let common = 0;
      while (
        common < prevFormats.length &&
        common < formats.length &&
        prevFormats[common].type === formats[common].type &&
        prevFormats[common].htmlInline === formats[common].htmlInline
      ) {
        common++;
      }

      const toClose = prevFormats.slice(common);
      result += closeTags(toClose);

      const toOpen = formats.slice(common);
      result += openTags(toOpen);

      result += text;
      prevFormats = formats;
    }

    result += closeTags(prevFormats);

    this.write(result);

    this._inlineBuffer = [];
  }

  closeBlock(node: LexicalNode): void {
    this._closed = node;
  }

  close() {
    this._closed = false;
  }

  wrapBlock(
    delim: string,
    firstDelim: string | null,
    node: LexicalNode,
    fn: () => void,
  ): void {
    const prevDelim = this.getDelim();

    this.write(firstDelim || delim);
    this.setDelim(this.getDelim() + delim);
    fn();
    this.setDelim(prevDelim);
    this.closeBlock(node);
  }

  convertBlock(node: LexicalNode): void {
    let conversion: MarkdownConversion<LexicalNode> | null = null;

    for (const conversionMap of this._conversionCollection) {
      const getConversion = conversionMap[node.getType()];
      if (!getConversion) {
        continue;
      }

      const markdownConversion = getConversion(node);
      if (!markdownConversion) {
        continue;
      }

      if (conversion) {
        const prevPriority = conversion.priority || 0;
        const priority = markdownConversion.priority || 0;

        if (prevPriority < priority) {
          conversion = markdownConversion;
        }
      } else {
        conversion = markdownConversion;
      }
    }

    if (conversion) {
      conversion.conversion(node, this);
    } else {
      // TODO: $generateHtmlFromNodes
    }
  }

  convertInline(parent: LexicalNode): void {
    if ($isElementNode(parent)) {
      parent.getChildren().forEach((node) => {
        this.convertBlock(node);
      });
    } else {
      // ??
      this.convertBlock(parent);
    }
    this.flushInline();
  }

  convertNode(parent: ElementNode): void {
    parent.getChildren().forEach((child) => {
      this.convertBlock(child);
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function convertList(
  state: MarkdownConvertorState,
  node: ElementNode,
  delim: string,
  firstDelimFn: (index: number) => string,
) {
  const closed = state.getClosed();

  if (closed && closed.getType() === node.getType()) {
    state.flushClose(3);
  } else {
    state.flushClose(1);
  }

  node.getChildren().forEach((child, index) => {
    if (index) {
      state.flushClose(1);
    }

    state.wrapBlock(delim, firstDelimFn(index), node, () => {
      state.convertBlock(child);
    });
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function convertTableCell(state: MarkdownConvertorState, node: ElementNode) {
  state.setStopNewline(true);

  node.getChildren().forEach((child) => {
    if ($isParagraphNode(child)) {
      state.convertBlock(child);
      state.close();
    } else if ($isBlockElementNode(child) || $isDecoratorNode(child)) {
      // TODO: $generateHtmlFromNodes
      state.close();
    } else {
      state.convertInline(child);
    }
  });

  state.setStopNewline(false);
}

const defaultMarkdownConversionMap: MarkdownConversionMap = {
  [TextNode.getType()]: () => ({
    conversion: (node: LexicalNode, state: MarkdownConvertorState) => {
      if (!$isTextNode(node)) {
        return;
      }

      const formats: InlineFormat[] = [];

      if (node.hasFormat('bold')) {
        formats.push({
          closeTag: '**',
          openTag: '**',
          type: 'bold',
        });
      }

      if (node.hasFormat('strikethrough')) {
        formats.push({
          closeTag: '~~',
          openTag: '~~',
          type: 'strikethrough',
        });
      }

      if (node.hasFormat('italic')) {
        formats.push({
          closeTag: '*',
          openTag: '*',
          type: 'italic',
        });
      }

      if (node.hasFormat('code')) {
        formats.push({
          closeTag: '`',
          openTag: '`',
          type: 'code',
        });
      }

      if (node.hasFormat('highlight')) {
        formats.push({
          closeTag: '</mark>',
          htmlInline: true,
          openTag: '<mark>',
          type: 'highlight',
        });
      }

      if (node.hasFormat('underline')) {
        formats.push({
          closeTag: '</u>',
          htmlInline: true,
          openTag: '<u>',
          type: 'underline',
        });
      }

      if (node.hasFormat('subscript')) {
        formats.push({
          closeTag: '</sub>',
          htmlInline: true,
          openTag: '<sub>',
          type: 'subscript',
        });
      }

      if (node.hasFormat('superscript')) {
        formats.push({
          closeTag: '</sup>',
          htmlInline: true,
          openTag: '<sup>',
          type: 'superscript',
        });
      }

      // escape
      state.writeInline({
        formats,
        text: node.getTextContent(),
      });
    },
    priority: 0,
  }),
  [LineBreakNode.getType()]: () => ({
    conversion: (node: LexicalNode, state: MarkdownConvertorState) => {
      if (!$isLineBreakNode(node)) {
        return;
      }

      state.ensureNewLine();
    },
    priority: 0,
  }),
  [TabNode.getType()]: (node: LexicalNode) => {
    if (!$isTabNode(node)) {
      return null;
    }

    return {
      conversion: (__node: LexicalNode, state: MarkdownConvertorState) => {
        state.write(' '.repeat(4));
      },
      priority: 0,
    };
  },
  [ParagraphNode.getType()]: () => ({
    conversion: (node: LexicalNode, state: MarkdownConvertorState) => {
      if (!$isParagraphNode(node)) {
        return;
      }

      const stopNewline = state.getStopNewline();

      if (stopNewline) {
        state.convertInline(node);
      } else {
        if (node.isEmpty()) {
          state.write('<br>');
        } else {
          state.convertInline(node);
        }
        state.closeBlock(node);
      }
    },
    priority: 0,
  }),
};

export const headingMarkdownConversionMap: MarkdownConversionMap = {
  [HeadingNode.getType()]: () => ({
    conversion: (node: LexicalNode, state: MarkdownConvertorState) => {
      if (!$isHeadingNode(node)) {
        return;
      }

      const delim = '#'.repeat(Number(node.getTag().substring(1)));
      state.write(`${delim} `);
      state.convertInline(node);
      state.closeBlock(node);
    },
    priority: 0,
  }),
};

export function createGenerateMarkdownFromNode(
  ...markdownConversionCollection: MarkdownConversionMap[]
): (node: ElementNode) => string {
  const conversionCollection = new Set([
    defaultMarkdownConversionMap,
    ...markdownConversionCollection,
  ]);

  return (node: ElementNode): string => {
    const state = new MarkdownConvertorState(conversionCollection);
    state.convertNode(node);
    return state.getResult();
  };
}
