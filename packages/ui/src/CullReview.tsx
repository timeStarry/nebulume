import { For, Show, createSignal, onMount } from 'solid-js';
import Icon from './Icon';
import { Button } from './ui';
import { Thumbnail } from './PhotoView';
import { formatBytes } from './photo-actions';
import type { Asset } from './model';

const PREVIEW_LIMIT = 48;

/**
 * The end of a culling pass: keepers go out as JPEGs, rejects go to the system Trash.
 * Nothing happens to originals until the user presses the button in the reject column.
 */
export default function CullReview(props: {
  picks: Asset[];
  rejects: Asset[];
  /** Network-storage photos cannot be moved to the Trash. */
  canTrash: boolean;
  busy: boolean;
  onBack: () => void;
  onExport: (ids: string[]) => void;
  onTrash: (ids: string[]) => void;
}) {
  let back!: HTMLButtonElement;
  const [confirming, setConfirming] = createSignal(false);
  onMount(() => back.focus({ preventScroll: true }));
  const extraFiles = () =>
    props.rejects.reduce(
      (sum, item) => sum + (item.variants?.length ? item.variants.length - 1 : 0),
      0,
    );
  const rejectBytes = () => props.rejects.reduce((sum, item) => sum + (item.size || 0), 0);
  const Grid = (gridProps: { items: Asset[] }) => (
    <div class="review-grid">
      <For each={gridProps.items.slice(0, PREVIEW_LIMIT)}>
        {(item) => (
          <Thumbnail
            asset={item}
            tier="t256"
            compact
            tabbable={false}
            onSelect={() => {}}
            onOpen={() => {}}
          />
        )}
      </For>
      <Show when={gridProps.items.length > PREVIEW_LIMIT}>
        <span class="review-more">另 {gridProps.items.length - PREVIEW_LIMIT} 张</span>
      </Show>
    </div>
  );
  return (
    <section class="cull-review" role="region" aria-label="完成选片">
      <header class="cull-review-head">
        <h2>完成选片</h2>
        <Button ref={back} icon="left" onClick={() => props.onBack()}>
          继续选片
        </Button>
      </header>
      <div class="cull-review-cols">
        <div class="review-col">
          <h3 class="count-pick">
            <Icon name="check" size={16} />
            留用 {props.picks.length} 张
          </h3>
          <p>按裁剪导出为 JPEG，原片不变。</p>
          <Show
            when={props.picks.length}
            fallback={<p class="review-empty">这一轮没有留用的照片。</p>}
          >
            <Grid items={props.picks} />
          </Show>
          <div class="review-actions">
            <Button
              variant="primary"
              icon="export"
              disabled={!props.picks.length || props.busy}
              onClick={() => props.onExport(props.picks.map((item) => item.id))}
            >
              导出 JPEG…
            </Button>
          </div>
        </div>
        <div class="review-col">
          <h3 class="count-reject">
            <Icon name="close" size={16} />
            淘汰 {props.rejects.length} 张
          </h3>
          <p>移到系统废纸篓，RAW 与同名 JPEG 一起移动。可以撤销，也可以在废纸篓里“放回原处”。</p>
          <Show
            when={props.rejects.length}
            fallback={<p class="review-empty">这一轮没有淘汰的照片。</p>}
          >
            <Grid items={props.rejects} />
          </Show>
          <div class="review-actions">
            <Show
              when={props.canTrash}
              fallback={<span class="review-note">网络存储上的照片不能移到废纸篓。</span>}
            >
              <Show
                when={confirming()}
                fallback={
                  <Button
                    variant="danger"
                    icon="trash"
                    disabled={!props.rejects.length || props.busy}
                    onClick={() => setConfirming(true)}
                  >
                    移到废纸篓…
                  </Button>
                }
              >
                <Button
                  variant="danger"
                  disabled={props.busy}
                  onClick={() => {
                    setConfirming(false);
                    props.onTrash(props.rejects.map((item) => item.id));
                  }}
                >
                  确认移走 {props.rejects.length + extraFiles()} 个文件
                </Button>
                <Button variant="ghost" onClick={() => setConfirming(false)}>
                  取消
                </Button>
              </Show>
              <span class="review-note">
                {props.rejects.length + extraFiles()} 个文件
                <Show when={rejectBytes()}>，{formatBytes(rejectBytes())}</Show>
                <Show when={extraFiles()}>（含 {extraFiles()} 个同名 JPEG，未计入大小）</Show>
              </span>
            </Show>
          </div>
        </div>
      </div>
    </section>
  );
}
