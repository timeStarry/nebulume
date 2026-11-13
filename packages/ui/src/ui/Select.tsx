import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  splitProps,
  type JSX,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import Icon from '../Icon';
import './Field.css';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

type PopoverGeometry = {
  left: number;
  top: number;
  minWidth: number;
  maxHeight: number;
};

export default function Select(
  props: Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value'> & {
    value: string;
    options: SelectOption[];
    onChange: (value: string) => void;
    placeholder?: string;
    size?: 'sm' | 'md';
    wrapClass?: string;
    required?: boolean;
    ref?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  },
) {
  const [own, rest] = splitProps(props, [
    'value',
    'options',
    'onChange',
    'placeholder',
    'size',
    'wrapClass',
    'class',
    'required',
    'ref',
    'onKeyDown',
    'onClick',
  ]);

  let triggerEl: HTMLButtonElement | undefined;
  let popoverEl: HTMLDivElement | undefined;
  const listboxId = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(-1);
  const [geometry, setGeometry] = createSignal<PopoverGeometry>({
    left: 8,
    top: 8,
    minWidth: 160,
    maxHeight: 280,
  });

  const selectedIndex = createMemo(() =>
    own.options.findIndex((option) => option.value === own.value),
  );
  const selectedOption = createMemo(() => {
    const idx = selectedIndex();
    return idx >= 0 ? own.options[idx] : undefined;
  });
  const isPlaceholder = createMemo(() => {
    const sel = selectedOption();
    return !sel || (Boolean(sel.disabled) && sel.value === '');
  });

  function assignTriggerRef(el: HTMLButtonElement) {
    triggerEl = el;
    if (typeof own.ref === 'function') own.ref(el);
  }

  function firstEnabledIndex(from = 0, step: 1 | -1 = 1): number {
    const list = own.options;
    if (!list.length) return -1;
    for (let i = from; i >= 0 && i < list.length; i += step) {
      if (!list[i]?.disabled) return i;
    }
    return -1;
  }

  function updateGeometry() {
    if (!triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const margin = 8;
    const gap = 4;
    const minWidth = Math.min(Math.max(Math.round(rect.width), 148), vw - margin * 2);
    const actualWidth = popoverEl ? Math.max(popoverEl.offsetWidth, minWidth) : minWidth;
    const estimatedHeight = popoverEl
      ? popoverEl.scrollHeight + 2
      : Math.min(288, own.options.length * 34 + 10);
    const spaceBelow = vh - rect.bottom - margin - gap;
    const spaceAbove = rect.top - margin - gap;
    const placeAbove = spaceBelow < Math.min(estimatedHeight, 180) && spaceAbove > spaceBelow;
    const maxHeight = Math.max(96, Math.min(288, placeAbove ? spaceAbove : spaceBelow));
    const renderedHeight = Math.min(estimatedHeight, maxHeight);
    const top = placeAbove
      ? Math.max(margin, Math.round(rect.top - gap - renderedHeight))
      : Math.min(vh - margin - renderedHeight, Math.round(rect.bottom + gap));
    const left = Math.max(margin, Math.min(Math.round(rect.left), vw - actualWidth - margin));
    setGeometry({ left, top, minWidth, maxHeight });
  }

  function scrollActiveIntoView(index: number) {
    if (!popoverEl || index < 0) return;
    const item = popoverEl.querySelector<HTMLElement>(`[data-option-index="${index}"]`);
    item?.scrollIntoView?.({ block: 'nearest' });
  }

  function openMenu(preferLast = false) {
    if (rest.disabled || !own.options.length) return;
    const sel = selectedIndex();
    const initial =
      sel >= 0 && !own.options[sel]?.disabled
        ? sel
        : preferLast
          ? firstEnabledIndex(own.options.length - 1, -1)
          : firstEnabledIndex(0, 1);
    setActiveIndex(initial);
    setOpen(true);
    updateGeometry();
    requestAnimationFrame(() => {
      updateGeometry();
      scrollActiveIntoView(initial);
    });
  }

  function closeMenu(restoreFocus = false) {
    if (!open()) return;
    setOpen(false);
    if (restoreFocus) triggerEl?.focus({ preventScroll: true });
  }

  function commitIndex(index: number) {
    const option = own.options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    triggerEl?.focus({ preventScroll: true });
    if (option.value !== own.value || option.value.startsWith('__')) {
      own.onChange(option.value);
    }
  }

  function moveActive(delta: 1 | -1) {
    const list = own.options;
    if (!list.length) return;
    let cursor = activeIndex();
    if (cursor < 0) {
      cursor = delta > 0 ? -1 : list.length;
    }
    for (let step = 0; step < list.length; step++) {
      cursor = (cursor + delta + list.length) % list.length;
      if (!list[cursor]?.disabled) {
        setActiveIndex(cursor);
        scrollActiveIntoView(cursor);
        return;
      }
    }
  }

  createEffect(() => {
    if (!open()) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (triggerEl?.contains(target) || popoverEl?.contains(target)) return;
      closeMenu(false);
    };
    const onScroll = (event: Event) => {
      if (popoverEl && event.target instanceof Node && popoverEl.contains(event.target)) return;
      updateGeometry();
    };
    const onResize = () => updateGeometry();
    const onBlur = () => closeMenu(false);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onBlur);
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onBlur);
    });
  });

  function handleKeyDown(event: KeyboardEvent) {
    if (typeof own.onKeyDown === 'function') {
      own.onKeyDown(event as never);
    }
    if (event.defaultPrevented || rest.disabled) return;

    if (!open()) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openMenu(false);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        openMenu(true);
      }
      return;
    }

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        break;
      case 'Tab':
        closeMenu(false);
        break;
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        moveActive(-1);
        break;
      case 'Home': {
        event.preventDefault();
        event.stopPropagation();
        const idx = firstEnabledIndex(0, 1);
        if (idx >= 0) {
          setActiveIndex(idx);
          scrollActiveIntoView(idx);
        }
        break;
      }
      case 'End': {
        event.preventDefault();
        event.stopPropagation();
        const idx = firstEnabledIndex(own.options.length - 1, -1);
        if (idx >= 0) {
          setActiveIndex(idx);
          scrollActiveIntoView(idx);
        }
        break;
      }
      case 'Enter':
      case ' ':
        event.preventDefault();
        event.stopPropagation();
        if (activeIndex() >= 0) commitIndex(activeIndex());
        else closeMenu(true);
        break;
    }
  }

  return (
    <>
      <button
        {...rest}
        ref={assignTriggerRef}
        type="button"
        role="combobox"
        aria-expanded={open()}
        aria-haspopup="listbox"
        aria-controls={open() ? listboxId : undefined}
        aria-activedescendant={
          open() && activeIndex() >= 0 ? `${listboxId}-opt-${activeIndex()}` : undefined
        }
        aria-required={own.required || undefined}
        data-value={own.value}
        class={`nl-select nl-select--${own.size ?? 'md'}${rest.disabled ? ' nl-select--disabled' : ''}${own.wrapClass ? ` ${own.wrapClass}` : ''}${own.class ? ` ${own.class}` : ''}`}
        onKeyDown={handleKeyDown}
        onClick={(event) => {
          if (typeof own.onClick === 'function') own.onClick(event as never);
          if (event.defaultPrevented || rest.disabled) return;
          if (open()) closeMenu(true);
          else openMenu(false);
        }}
      >
        <span class={`nl-select-value${isPlaceholder() ? ' nl-select-value--placeholder' : ''}`}>
          {selectedOption()?.label ?? own.placeholder ?? ''}
        </span>
        <span class={`nl-select-arrow${open() ? ' nl-select-arrow--open' : ''}`} aria-hidden="true">
          <Icon name="chevron-down" size={14} />
        </span>
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={(el) => (popoverEl = el)}
            id={listboxId}
            role="listbox"
            tabIndex={-1}
            class={`nl-select-popover nl-select-popover--${own.size ?? 'md'}`}
            style={{
              left: `${geometry().left}px`,
              top: `${geometry().top}px`,
              'min-width': `${geometry().minWidth}px`,
              'max-height': `${geometry().maxHeight}px`,
            }}
            onMouseDown={(event) => event.preventDefault()}
          >
            <For each={own.options}>
              {(option, index) => {
                const isSelected = () => option.value === own.value && !option.value.startsWith('__');
                const isActive = () => activeIndex() === index();
                return (
                  <div
                    id={`${listboxId}-opt-${index()}`}
                    role="option"
                    data-option-index={index()}
                    data-value={option.value}
                    aria-selected={isSelected()}
                    aria-disabled={option.disabled || undefined}
                    class="nl-select-option"
                    classList={{
                      'nl-select-option--selected': isSelected(),
                      'nl-select-option--active': isActive(),
                      'nl-select-option--disabled': !!option.disabled,
                    }}
                    onPointerMove={() => {
                      if (!option.disabled && activeIndex() !== index()) {
                        setActiveIndex(index());
                      }
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!option.disabled) commitIndex(index());
                    }}
                  >
                    <span class="nl-select-option-body">
                      <span class="nl-select-option-label">{option.label}</span>
                      <Show when={option.description}>
                        <span class="nl-select-option-desc">{option.description}</span>
                      </Show>
                    </span>
                    <span class="nl-select-option-check" aria-hidden="true">
                      <Show when={isSelected()}>
                        <Icon name="check" size={14} />
                      </Show>
                    </span>
                  </div>
                );
              }}
            </For>
          </div>
        </Portal>
      </Show>
    </>
  );
}
