import type { BaseBlockModel, Page } from '@blocksuite/store';
import type { EmbedBlockComponent } from '../../embed-block';
import { showFormatQuickBar } from '../../components/format-quick-bar';
import {
  assertExists,
  caretRangeFromPoint,
  handleNativeRangeClick,
  handleNativeRangeDblClick,
  handleNativeRangeDragMove,
  initMouseEventHandlers,
  isBlankArea,
  isEmbed,
  noop,
  resetNativeSelection,
  SelectionEvent,
  getModelByElement,
  getBlockElementByModel,
  getAllBlocks,
  getDefaultPageBlock,
  isInput,
} from '../../__internal__';
import type { RichText } from '../../__internal__/rich-text/rich-text';
import {
  getNativeSelectionMouseDragInfo,
  repairContextMenuRange,
} from '../utils/cursor';
import type { DefaultPageSignals } from './default-page-block';
import { getBlockEditingStateByPosition } from './utils';
import { matchFlavours } from '@blocksuite/store/src/utils/utils';

function intersects(rect: DOMRect, selectionRect: DOMRect) {
  return (
    rect.left < selectionRect.right &&
    rect.right > selectionRect.left &&
    rect.top < selectionRect.bottom &&
    rect.bottom > selectionRect.top
  );
}

function filterSelectedBlock(
  blockCache: Map<Element, DOMRect>,
  selectionRect: DOMRect
): Element[] {
  const blocks = Array.from(blockCache.keys());
  return blocks.filter(block => {
    const rect = block.getBoundingClientRect();
    return intersects(rect, selectionRect);
  });
}

// TODO
// function filterSelectedEmbed(
//   embedCache: Map<EmbedBlockComponent, DOMRect>,
//   selectionRect: DOMRect
// ): EmbedBlockComponent[] {
//   const embeds = Array.from(embedCache.keys());
//   return embeds.filter(embed => {
//     const rect = embed.getBoundingClientRect();
//     return intersects(rect, selectionRect);
//   });
// }

function createSelectionRect(
  current: { x: number; y: number },
  start: { x: number; y: number }
) {
  const width = Math.abs(current.x - start.x);
  const height = Math.abs(current.y - start.y);
  const left = Math.min(current.x, start.x);
  const top = Math.min(current.y, start.y);
  return new DOMRect(left, top, width, height);
}

type PageSelectionType = 'native' | 'block' | 'none' | 'embed';

class PageSelectionState {
  type: PageSelectionType;
  selectEmbeds: EmbedBlockComponent[] = [];
  selectedBlocks: Element[] = [];
  private _startRange: Range | null = null;
  private _startPoint: { x: number; y: number } | null = null;
  private _richTextCache = new Map<RichText, DOMRect>();
  private _blockCache = new Map<Element, DOMRect>();
  private _embedCache = new Map<EmbedBlockComponent, DOMRect>();

  constructor(type: PageSelectionType) {
    this.type = type;
  }

  get startRange() {
    return this._startRange;
  }

  get startPoint() {
    return this._startPoint;
  }

  get richTextCache() {
    return this._richTextCache;
  }

  get blockCache() {
    return this._blockCache;
  }
  get embedCache() {
    return this._embedCache;
  }

  resetStartRange(e: SelectionEvent) {
    this._startRange = caretRangeFromPoint(e.raw.clientX, e.raw.clientY);
    this._startPoint = { x: e.raw.clientX, y: e.raw.clientY };
  }

  refreshRichTextBoundsCache(container: HTMLElement) {
    const allBlocks = getAllBlocks();
    allBlocks.forEach(block => {
      const rect = block.getBoundingClientRect();
      this._blockCache.set(block, rect);
    });
  }

  clear() {
    this.type = 'none';
    this._richTextCache.clear();
    this._startRange = null;
    this._startPoint = null;
    this.selectedBlocks = [];
  }
}

export class DefaultSelectionManager {
  page: Page;
  state = new PageSelectionState('none');
  private _container: HTMLElement;
  private _mouseDisposeCallback: () => void;
  private _signals: DefaultPageSignals;
  private _originPosition: { x: number; y: number } = { x: 0, y: 0 };
  private _dropContainer: HTMLElement | null = null;
  private _dropContainerSize: { w: number; h: number; left: number } = {
    w: 0,
    h: 0,
    left: 0,
  };
  private _activeComponent: HTMLElement | null = null;
  private _dragMoveTarget = 'right';
  constructor(
    space: Page,
    container: HTMLElement,
    signals: DefaultPageSignals
  ) {
    this.page = space;
    this._signals = signals;
    this._container = container;
    this._mouseDisposeCallback = initMouseEventHandlers(
      this._container,
      this._onContainerDragStart,
      this._onContainerDragMove,
      this._onContainerDragEnd,
      this._onContainerClick,
      this._onContainerDblClick,
      this._onContainerMouseMove,
      this._onContainerMouseOut,
      this._onContainerContextMenu
    );
    // this._initListenNativeSelection();
  }
  private get _blocks(): BaseBlockModel[] {
    return (this.page.root?.children[0].children as BaseBlockModel[]) ?? [];
  }

  private _onBlockSelectionDragStart(e: SelectionEvent) {
    this.state.type = 'block';
    this.state.resetStartRange(e);
    this.state.refreshRichTextBoundsCache(this._container);
    resetNativeSelection(null);
  }

  private _onBlockSelectionDragMove(e: SelectionEvent) {
    assertExists(this.state.startPoint);
    const { selectionRect, selectedBlocks, blockCache } =
      this._getSelectedBlockInfo(e);
    this.state.selectedBlocks = selectedBlocks;

    const selectedBounds = selectedBlocks.map(block => {
      return blockCache.get(block) as DOMRect;
    });
    this._signals.updateSelectedRects.emit(selectedBounds);
    this._signals.updateFrameSelectionRect.emit(selectionRect);
  }

  private _getSelectedBlockInfo(e: SelectionEvent) {
    assertExists(this.state.startPoint);
    const current = { x: e.raw.clientX, y: e.raw.clientY };
    const { startPoint: start } = this.state;
    const selectionRect = createSelectionRect(current, start);

    const { blockCache } = this.state;

    const selectedBlocks = filterSelectedBlock(blockCache, selectionRect);

    return {
      selectionRect,
      selectedBlocks,
      blockCache,
    };
  }

  private _onBlockSelectionDragEnd(e: SelectionEvent) {
    this.state.type = 'block';
    this._signals.updateFrameSelectionRect.emit(null);
    // do not clear selected rects here
  }

  private _onNativeSelectionDragStart(e: SelectionEvent) {
    this._signals.nativeSelection.emit(false);
    this.state.type = 'native';
  }

  private _onNativeSelectionDragMove(e: SelectionEvent) {
    handleNativeRangeDragMove(this.state.startRange, e);
  }

  private _onNativeSelectionDragEnd(e: SelectionEvent) {
    this._signals.nativeSelection.emit(true);
    noop();
  }

  private _onContainerDragStart = (e: SelectionEvent) => {
    this.state.resetStartRange(e);
    if (isInput(e.raw)) return;
    if (isEmbed(e)) {
      this._onEmbedDragStart(e);
      return;
    }
    if (isBlankArea(e)) {
      this._onBlockSelectionDragStart(e);
    } else {
      this._onNativeSelectionDragStart(e);
    }
  };

  private _onEmbedDragStart = (e: SelectionEvent) => {
    this.state.type = 'embed';
    this._originPosition.x = e.raw.pageX;
    this._originPosition.y = e.raw.pageY;
    this._dropContainer = (e.raw.target as HTMLElement).closest('.resizes');
    this._dropContainerSize.w = this._dropContainer?.getBoundingClientRect()
      .width as number;
    this._dropContainerSize.h = this._dropContainer?.getBoundingClientRect()
      .height as number;
    this._dropContainerSize.left = this._dropContainer?.offsetLeft as number;
    if ((e.raw.target as HTMLElement).className.includes('right')) {
      this._dragMoveTarget = 'right';
    } else {
      this._dragMoveTarget = 'left';
    }
  };

  private _onContainerDragMove = (e: SelectionEvent) => {
    if (this.state.type === 'native') {
      this._onNativeSelectionDragMove(e);
    } else if (this.state.type === 'block') {
      this._onBlockSelectionDragMove(e);
    } else if (this.state.type === 'embed') {
      this._onEmbedDragMove(e);
    }
  };

  private _onEmbedDragMove(e: SelectionEvent) {
    let width = 0;
    let height = 0;
    let left = 0;
    if (this._dragMoveTarget === 'right') {
      width =
        this._dropContainerSize.w + (e.raw.pageX - this._originPosition.x);
    } else {
      width =
        this._dropContainerSize.w - (e.raw.pageX - this._originPosition.x);
    }
    if (width <= 700) {
      left =
        this._dropContainerSize.left -
        (e.raw.pageX - this._originPosition.x) / 2;
      height = width * (this._dropContainerSize.h / this._dropContainerSize.w);
      if (this._dropContainer) {
        this._signals.updateEmbedRects.emit([
          {
            width: width,
            height: height,
            left: left,
            top: this._dropContainer.getBoundingClientRect().top,
          },
        ]);
        const activeImg = this._activeComponent?.querySelector('img');
        if (activeImg) {
          activeImg.style.width = width + 'px';
          activeImg.style.height = height + 'px';
        }
      }
    }
  }

  private _onContainerDragEnd = (e: SelectionEvent) => {
    if (this.state.type === 'native') {
      this._onNativeSelectionDragEnd(e);
    } else if (this.state.type === 'block') {
      this._onBlockSelectionDragEnd(e);
    } else if (this.state.type === 'embed') {
      this._onEmbedDragEnd();
    }
    this._showFormatQuickBar(e);
  };

  private _onEmbedDragEnd() {
    assertExists(this._activeComponent);
    const dragModel = getModelByElement(this._activeComponent);
    dragModel.page.captureSync();
    assertExists(this._dropContainer);
    const { width, height } = this._dropContainer.getBoundingClientRect();
    dragModel.page.updateBlock(dragModel, { width: width, height: height });
  }

  private _showFormatQuickBar(e: SelectionEvent) {
    if (this.state.type === 'native') {
      const { anchor, direction, selectedType } =
        getNativeSelectionMouseDragInfo(e);
      if (selectedType === 'Caret') {
        // If nothing is selected, then we should not show the format bar
        return;
      }

      showFormatQuickBar({ anchorEl: anchor, direction });
    } else if (this.state.type === 'block') {
      // TODO handle block selection
      // const direction = getDragDirection(e);
      // const { selectedRichTexts } = this._getSelectedBlockInfo(e);
      // if (selectedRichTexts.length === 0) {
      //   // Selecting nothing
      //   return;
      // }
      // const selectedBlocks = selectedRichTexts.map(richText => {
      //   return getBlockById(richText.model.id) as unknown as HTMLElement;
      // });
      // const selectedType: SelectedBlockType = selectedBlocks.every(block => {
      //   return /paragraph-block/i.test(block.tagName);
      // })
      //   ? 'text'
      //   : 'other';
      // console.log(`selectedType: ${selectedType}`, this.state.type);
      // const anchor = ['rightDown', 'leftDown'].includes(direction)
      //   ? selectedBlocks[selectedBlocks.length - 1]
      //   : selectedBlocks[0];
      // showFormatQuickBar({ anchorEl: anchor });
    }
  }

  private _onContainerClick = (e: SelectionEvent) => {
    this.state.clear();
    this._signals.updateSelectedRects.emit([]);
    this._signals.updateEmbedRects.emit([]);

    if ((e.raw.target as HTMLElement).tagName === 'DEBUG-MENU') return;

    // container click will blur all captions
    const allCaptions = Array.from(
      document.querySelectorAll('.affine-embed-wrapper-caption')
    );
    allCaptions.forEach(el => {
      if (el !== e.raw.target) {
        (el as HTMLInputElement).blur();
      }
    });

    const clickBlockInfo = getBlockEditingStateByPosition(
      this._blocks,
      e.raw.pageX,
      e.raw.pageY
    );

    if (clickBlockInfo && clickBlockInfo.model) {
      const { model } = clickBlockInfo;
      const page = getDefaultPageBlock(model);
      page.lastSelectionPosition = 'start';
    }

    if (
      clickBlockInfo &&
      matchFlavours(clickBlockInfo.model, ['affine:embed', 'affine:divider'])
    ) {
      this.state.type = 'block';
      window.getSelection()?.removeAllRanges();

      assertExists(clickBlockInfo?.model);
      this._activeComponent = getBlockElementByModel(clickBlockInfo?.model);

      assertExists(this._activeComponent);
      if (clickBlockInfo.model.type === 'image') {
        this._signals.updateEmbedRects.emit([clickBlockInfo.position]);
      } else {
        this._signals.updateSelectedRects.emit([clickBlockInfo.position]);
      }
      this.state.selectedBlocks.push(this._activeComponent);
      return;
    }
    if (e.raw.target instanceof HTMLInputElement) return;
    if (e.keys.shift) return;
    handleNativeRangeClick(this.page, e);
  };

  private _onContainerDblClick = (e: SelectionEvent) => {
    this.state.clear();
    this._signals.updateSelectedRects.emit([]);
    if ((e.raw.target as HTMLElement).tagName === 'DEBUG-MENU') return;
    if (e.raw.target instanceof HTMLInputElement) return;
    handleNativeRangeDblClick(this.page, e);
  };

  private _onContainerContextMenu = (e: SelectionEvent) => {
    repairContextMenuRange(e);
  };

  private _onContainerMouseMove = (e: SelectionEvent) => {
    const hoverEditingState = getBlockEditingStateByPosition(
      this._blocks,
      e.raw.pageX,
      e.raw.pageY
    );

    if (hoverEditingState?.model.type === 'image') {
      hoverEditingState.position.x = hoverEditingState.position.right + 10;
      this._signals.updateEmbedEditingState.emit(hoverEditingState);
    } else {
      this._signals.updateEmbedEditingState.emit(null);
    }
  };

  private _onContainerMouseOut = (e: SelectionEvent) => {
    // console.log('mouseout', e);
  };

  // TODO fix  native selection and delete after non-text
  // private _initListenNativeSelection() {
  //   document.addEventListener('selectionchange', this._onNativeSelectionChange);
  // }

  // private _onNativeSelectionChange = () => {
  //   const selection = window.getSelection();
  //   if (selection?.isCollapsed && selection?.rangeCount) {
  //     let { anchorNode } = selection;
  //     this.state.type = 'native';
  //     if (anchorNode) {
  //       anchorNode =
  //         anchorNode instanceof Element ? anchorNode : anchorNode.parentElement;
  //       const blockModel = getModelByElement(anchorNode as Element);
  //       if (blockModel) {
  //         const block = getBlockById(blockModel.id);
  //         if (block) {
  //           this.state.selectedBlocks = [block];
  //           this._signals.updateSelectedRects.emit([]);
  //           this._signals.updateFrameSelectionRect.emit(null);
  //         }
  //       }
  //     }
  //   }
  // };

  dispose() {
    this._signals.updateSelectedRects.dispose();
    this._signals.updateFrameSelectionRect.dispose();
    this._signals.updateEmbedEditingState.dispose();
    this._signals.updateEmbedRects.dispose();
    this._mouseDisposeCallback();
  }

  selectBlockByRect(selectionRect: DOMRect, model?: BaseBlockModel) {
    this.state.type = 'block';
    this.state.refreshRichTextBoundsCache(this._container);
    const { blockCache } = this.state;
    const selectedBlocks = filterSelectedBlock(blockCache, selectionRect);
    this.state.selectedBlocks = selectedBlocks;
    const selectedBounds: DOMRect[] = [selectionRect];
    this._signals.updateSelectedRects.emit(selectedBounds);
  }
}
