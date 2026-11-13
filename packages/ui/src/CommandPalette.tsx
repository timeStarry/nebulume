import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import {
  buildCommandItems,
  filterCommandItems,
  type CommandAction,
  type CommandItem,
  type CommandPaletteSource,
} from './command-palette';
import { Dialog, Kbd, TextInput } from './ui';
import './CommandPalette.css';

export default function CommandPalette(props: {
  source: CommandPaletteSource;
  onSelect: (action: CommandAction) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal('');
  const [activeIndex, setActiveIndex] = createSignal(0);

  const allItems = createMemo(() => buildCommandItems(props.source));
  const filtered = createMemo(() => filterCommandItems(allItems(), query()));

  createEffect(() => {
    query();
    setActiveIndex(0);
  });

  function trigger(item: CommandItem | undefined) {
    if (!item) return;
    props.onClose();
    props.onSelect(item.action);
  }

  function onKeyDown(event: KeyboardEvent) {
    const list = filtered();
    if (!list.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % list.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + list.length) % list.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      trigger(list[activeIndex()]);
    }
  }

  const rows = createMemo(() => {
    const out: { header?: string; item: CommandItem; index: number }[] = [];
    let prevCat = '';
    const isSearching = !!query().trim();
    filtered().forEach((item, index) => {
      const header = !isSearching && item.categoryLabel !== prevCat ? item.categoryLabel : undefined;
      prevCat = item.categoryLabel;
      out.push({ header, item, index });
    });
    return out;
  });

  return (
    <Dialog
      title="命令面板"
      subtitle="搜索图片库、精选集、文件夹、快速筛选或系统设置（↑↓ 选择，Enter 执行）"
      width={540}
      onClose={props.onClose}
    >
      <div class="command-palette-body" onKeyDown={onKeyDown}>
        <TextInput
          icon="search"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          placeholder="输入图库、精选集、文件夹、色标或命令…"
          aria-label="搜索命令或目标"
          maxLength={120}
        />
        <Show
          when={rows().length}
          fallback={<p class="command-palette-empty">未找到匹配的图库、精选集、目录或命令。</p>}
        >
          <ul class="command-palette-list" role="listbox" aria-label="命令结果">
            <For each={rows()}>
              {(row) => (
                <>
                  <Show when={row.header}>
                    <li class="command-palette-group" role="presentation">
                      {row.header}
                    </li>
                  </Show>
                  <li role="option" aria-selected={activeIndex() === row.index}>
                    <button
                      type="button"
                      class="command-palette-item"
                      classList={{ active: activeIndex() === row.index }}
                      onMouseEnter={() => setActiveIndex(row.index)}
                      onClick={() => trigger(row.item)}
                    >
                      <span class="command-palette-copy">
                        <strong>{row.item.title}</strong>
                        <Show when={row.item.subtitle}>
                          <small>{row.item.subtitle}</small>
                        </Show>
                      </span>
                      <Show when={row.item.shortcut}>
                        <Kbd>{row.item.shortcut!}</Kbd>
                      </Show>
                    </button>
                  </li>
                </>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </Dialog>
  );
}
