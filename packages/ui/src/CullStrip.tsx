import { For, Show, createEffect, on } from 'solid-js';
import { Thumbnail } from './PhotoView';
import type { Asset } from './model';

/** The queue as a strip: a green or red line marks the flag, photos already seen are brighter. */
export default function CullStrip(props: {
  ids: string[];
  items: Record<string, Asset>;
  current?: string;
  seen: Set<string>;
  onSelect: (id: string) => void;
}) {
  let strip!: HTMLDivElement;
  // Render a window around the current photo; queues can hold thousands.
  const windowed = () => {
    const index = Math.max(0, props.ids.indexOf(props.current || ''));
    const start = Math.max(0, index - 40);
    return props.ids.slice(start, index + 41);
  };
  createEffect(
    on(
      () => props.current,
      (current) =>
        queueMicrotask(() =>
          strip
            ?.querySelector<HTMLElement>(`[data-id="${CSS.escape(current || '')}"]`)
            ?.scrollIntoView({ block: 'nearest', inline: 'center' }),
        ),
    ),
  );
  return (
    <div ref={strip} class="cull-strip" aria-label="选片队列">
      <For each={windowed()}>
        {(id) => (
          <div
            class={`cull-strip-item ${props.seen.has(id) ? 'seen' : ''} ${id === props.current ? 'current' : ''}`}
            data-id={id}
          >
            <Show when={props.items[id]} fallback={<span class="cull-strip-empty" />}>
              {(item) => (
                <Thumbnail
                  asset={item()}
                  tier="t256"
                  compact
                  tabbable={false}
                  selected={id === props.current}
                  onSelect={() => props.onSelect(id)}
                  onOpen={() => props.onSelect(id)}
                />
              )}
            </Show>
            <Show when={props.items[id]?.flag === 'pick' || props.items[id]?.flag === 'reject'}>
              <span class={`cull-strip-mark ${props.items[id]!.flag}`} aria-hidden="true" />
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
