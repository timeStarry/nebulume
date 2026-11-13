import { For, Show, createResource, createSignal } from 'solid-js';
import { execute } from '../api';
import { errorMessage, type Asset, type ColorLabel } from '../model';
import { COLOR_LABEL_NAMES } from '../undo';
import { Button, Chip, TextInput } from '../ui';
import './KeywordSection.css';

export const COLOR_LABEL_SWATCHES: Exclude<ColorLabel, 'none'>[] = ['red', 'yellow', 'green', 'blue'];

export function ColorLabelDots(props: {
  value?: ColorLabel;
  disabled?: boolean;
  onChange?: (next: ColorLabel) => void;
}) {
  const current = () => props.value || 'none';
  return (
    <Show when={props.onChange}>
      <div class="inspector-color-dots" role="group" aria-label="照片色标">
        <For each={COLOR_LABEL_SWATCHES}>
          {(color) => (
            <button
              type="button"
              class="inspector-color-dot"
              classList={{ active: current() === color }}
              data-color={color}
              disabled={props.disabled}
              aria-label={COLOR_LABEL_NAMES[color]}
              aria-pressed={current() === color}
              title={`${COLOR_LABEL_NAMES[color]}（再点清除）`}
              onClick={() => props.onChange!(current() === color ? 'none' : color)}
            />
          )}
        </For>
        <button
          type="button"
          class="inspector-color-clear"
          disabled={props.disabled || current() === 'none'}
          onClick={() => props.onChange!('none')}
        >
          无色标
        </button>
      </div>
    </Show>
  );
}

export default function KeywordSection(props: {
  asset: Asset;
  disabled?: boolean;
  onUpdated?: (keywords: string[]) => void;
}) {
  const [draft, setDraft] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal('');

  const [libraryKeywords, { refetch }] = createResource(
    () => props.asset.library_id,
    async (libraryId) => {
      try {
        const list = await execute<{ path: string; count: number }[]>('library.keywords', {
          library_id: libraryId,
        });
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    },
  );

  const keywords = () => props.asset.keywords || [];

  const suggestions = () => {
    const owned = new Set(keywords());
    const q = draft().trim().toLowerCase();
    return (libraryKeywords() || [])
      .filter((item) => !owned.has(item.path) && (!q || item.path.toLowerCase().includes(q)))
      .slice(0, 6);
  };

  async function mutateKeywords(add: string[], remove: string[]) {
    if (saving()) return;
    setSaving(true);
    setError('');
    try {
      const res = await execute<{ keywords: string[] }>('asset.keywords.set', {
        ids: [props.asset.id],
        add,
        remove,
      });
      props.onUpdated?.(res.keywords);
      void refetch();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function submitDraft(event?: Event) {
    event?.preventDefault();
    const parts = draft()
      .split(/[,，;；]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (!parts.length) return;
    setDraft('');
    void mutateKeywords(parts, []);
  }

  return (
    <section class="inspector-section" aria-label="层级关键词">
      <div class="section-title">
        <h3>关键词</h3>
        <span>用 &gt; 分级</span>
      </div>
      <Show
        when={keywords().length}
        fallback={<p class="keyword-empty">尚未添加关键词（支持“人像 &gt; 客片”层级并同步 .xmp）。</p>}
      >
        <div class="keyword-chips" role="list" aria-label="当前照片关键词">
          <For each={keywords()}>
            {(kw) => (
              <Chip
                label={kw}
                onRemove={props.disabled || saving() ? undefined : () => void mutateKeywords([], [kw])}
              />
            )}
          </For>
        </div>
      </Show>
      <form class="keyword-form" onSubmit={submitDraft}>
        <TextInput
          size="sm"
          value={draft()}
          disabled={props.disabled || saving()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          placeholder="如：人像 > 客片"
          aria-label="输入关键词"
          maxLength={120}
        />
        <Button
          size="sm"
          type="submit"
          disabled={props.disabled || saving() || !draft().trim()}
        >
          添加
        </Button>
      </form>
      <Show when={suggestions().length}>
        <div class="keyword-suggestions" aria-label="常用关键词建议">
          <For each={suggestions()}>
            {(item) => (
              <button
                type="button"
                class="keyword-suggest-btn"
                disabled={props.disabled || saving()}
                onClick={() => void mutateKeywords([item.path], [])}
              >
                + {item.path}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={error()}>
        <p class="form-error" role="alert">
          {error()}
        </p>
      </Show>
    </section>
  );
}
