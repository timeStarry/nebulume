import { For, Show, createSignal } from 'solid-js';
import Icon from './Icon';
import { diagnosticLabels, metadataFieldLabel } from './inspector-metadata';
import {
  NAMED_FIELDS,
  fieldLabel,
  fieldValue,
  movePinned,
  readPinned,
  togglePinned,
  writePinned,
  type FieldId,
} from './inspector-fields';
import type { Asset } from './model';
import './PinnedFields.css';

// Any field can be pinned, including ones this photo lacks (they show "—").
const anyField = {
  has: (id: string) => typeof id === 'string' && id.length > 0 && id.length < 200,
} as Set<string>;
const [pinned, setPinnedSignal] = createSignal<FieldId[]>(readPinned(localStorage, anyField));
function setPinned(next: FieldId[]) {
  setPinnedSignal(next);
  writePinned(localStorage, next);
}
/** Keys a named field already shows, so the rest of the list does not repeat them. */
const COVERED: Record<string, string[]> = {
  exposure: ['Aperture', 'FNumber', 'Exposure', 'ExposureTime', 'ISO', 'PhotographicSensitivity'],
  focal: ['Focal Length', 'FocalLength'],
  lens: ['Lens', 'LensModel'],
  body: ['Camera', 'Model'],
  captured: ['Captured', 'DateTimeOriginal'],
  dimensions: [],
};
const label = (id: FieldId) => (NAMED_FIELDS[id] ? fieldLabel(id) : metadataFieldLabel(id));

/**
 * The photo's recorded fields: the ones the user pinned first, in their order, then every
 * other recorded field once, each with a pin. Pinned rows are focusable: Alt+↑/↓ reorders,
 * Enter unpins. Raw EXIF tags and decoder diagnostics stay in their own disclosures.
 */
export default function PinnedFields(props: { asset: Asset }) {
  let list!: HTMLUListElement;
  const others = () => {
    // Exposure keys always show under the histogram; never repeat them here.
    const covered = new Set([
      ...COVERED.exposure,
      ...pinned().flatMap((id) => [id, ...(COVERED[id] ?? [])]),
    ]);
    return Object.entries(props.asset.metadata ?? {})
      .filter(
        ([key, value]) =>
          value?.trim() && !key.startsWith('EXIF ') && !diagnosticLabels[key] && !covered.has(key),
      )
      .map(([key, value]) => ({ key, value: value.trim() }));
  };
  function move(id: FieldId, delta: -1 | 1) {
    setPinned(movePinned(pinned(), id, delta));
    queueMicrotask(() =>
      list.querySelector<HTMLElement>(`[data-field="${CSS.escape(id)}"]`)?.focus(),
    );
  }
  const Pin = (pinProps: { id: FieldId }) => (
    <button
      type="button"
      class={`nl-pinned-pin${pinned().includes(pinProps.id) ? ' on' : ''}`}
      aria-label={`${pinned().includes(pinProps.id) ? '取消固定' : '固定'} ${pinProps.id}`}
      aria-pressed={pinned().includes(pinProps.id)}
      tabIndex={pinned().includes(pinProps.id) ? -1 : 0}
      onClick={() => setPinned(togglePinned(pinned(), pinProps.id))}
    >
      <Icon name="pin" size={14} />
    </button>
  );
  return (
    <section class="inspector-section nl-pinned shooting-parameters" aria-label="拍摄信息">
      <div class="section-title">
        <h3>拍摄信息</h3>
        <span>Alt+↑↓ 排序</span>
      </div>
      <ul ref={list} class="nl-pinned-list" aria-label="固定显示">
        <For
          each={pinned()}
          fallback={<li class="nl-pinned-empty">点下方字段的图钉，把它固定到这里。</li>}
        >
          {(id) => (
            <li
              class="nl-pinned-row"
              data-field={id}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                  event.preventDefault();
                  event.stopPropagation();
                  move(id, event.key === 'ArrowUp' ? -1 : 1);
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  setPinned(togglePinned(pinned(), id));
                }
              }}
            >
              <span class="nl-pinned-label">{label(id)}</span>
              <span class="nl-pinned-value">{fieldValue(id, props.asset) ?? '—'}</span>
              <Pin id={id} />
            </li>
          )}
        </For>
      </ul>
      <Show when={others().length}>
        <ul class="nl-pinned-list nl-other-fields" aria-label="全部字段">
          <For each={others()}>
            {(field) => (
              <li class="nl-pinned-row">
                <span class="nl-pinned-label">{metadataFieldLabel(field.key)}</span>
                <span class="nl-pinned-value">{field.value}</span>
                <Pin id={field.key} />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
