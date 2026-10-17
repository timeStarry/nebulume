// Test-only mounting surface for production preview components and their real client scheduler.
import { For, Show, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import PhotoView, { Thumbnail } from '../../src/PhotoView';
import type { Asset } from '../../src/model';
import '../../src/theme.css';
import '../../src/styles.css';
import '../../src/viewer.css';

declare global {
  interface Window {
    previewHarness: {
      thumbnails: (assets: Asset[]) => void;
      photo: (asset: Asset | undefined) => void;
    };
    previewVisibility: (filename: string, visible: boolean) => void;
  }
}
function Harness() {
  const [assets, setAssets] = createSignal<Asset[]>([]);
  const [current, setCurrent] = createSignal<Asset>();
  window.previewHarness = { thumbnails: setAssets, photo: setCurrent };
  return (
    <main>
      <div style={{ display: 'grid', 'grid-template-columns': 'repeat(4, 160px)', gap: '12px' }}>
        <For each={assets()}>
          {(asset) => (
            <Thumbnail asset={asset} onSelect={() => {}} onOpen={() => setCurrent(asset)} />
          )}
        </For>
      </div>
      <Show when={current()} keyed>
        {(asset) => (
          <div class="immersive-viewer" style={{ position: 'relative', height: '600px' }}>
            <PhotoView
              asset={asset}
              cropMode={false}
              crop={{ x: 0, y: 0, width: 1, height: 1 }}
              setCrop={() => {}}
              onPrevious={() => {}}
              onNext={() => {}}
              hasPrevious={false}
              hasNext={false}
            />
          </div>
        )}
      </Show>
    </main>
  );
}
render(() => <Harness />, document.getElementById('app')!);
